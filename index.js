import {
    getContext,
    renderExtensionTemplateAsync,
    extension_settings,
} from '../../../extensions.js';

import {
    // --- 核心应用函数 ---
    characters,
    saveSettingsDebounced,
    eventSource,
    event_types,
    selectCharacterById,    // 用于选择角色
    doNewChat,              // 用于创建新聊天
    printMessages,          // 用于刷新聊天UI
    scrollChatToBottom,     // 用于滚动到底部
    updateChatMetadata,     // 用于更新聊天元数据
    saveChatConditional,    // 用于保存聊天
    saveChat,               // 用于插件强制保存聊天
    getThumbnailUrl,        // 可能需要获取头像URL
    getRequestHeaders,      // 用于API请求的头部
    openCharacterChat,      // 用于打开角色聊天
    getPastCharacterChats,  // 获取角色的聊天列表
    getCharacters,          // 用于获取角色列表
} from '../../../../script.js';

import {
    // --- 群组相关函数 ---
    select_group_chats,     // 用于选择群组聊天
} from '../../../group-chats.js';

import { 
	POPUP_TYPE, 
	Popup,
	POPUP_RESULT,
} from '../../../popup.js';

import {
    waitUntilCondition,   // 轮询等待条件满足
} from '../../../utils.js';

// --- 备份类型枚举 ---
const BACKUP_TYPE = {
    STANDARD: 'standard', // 用于 AI 回复, 用户发送, 新swipe生成
    SWIPE: 'swipe'        // 用于在已存在的swipes之间切换
};

// --- 备份状态控制 ---
let isBackupInProgress = false; // 并发控制标志
let backupTimeout = null;       // 防抖定时器 ID
let currentBackupAttemptId = null; // 存储最新一次备份尝试的唯一ID

// --- 表格UI监听相关 ---
let metadataHashOnDrawerOpen = null; // 抽屉打开时的元数据哈希值
let tableDrawerElement = null; // 添加全局变量声明，用于保存抽屉元素引用

// 在文件顶部添加一个新的标志变量
let messageSentRecently = false;
let messageSentResetTimer = null;

// 全局请求超时常量 & 抽屉监听器实例
const FETCH_TIMEOUT_MS = 10000; // 毫秒
let drawerObserverInstance = null;

// 优化的高效哈希函数 - 专为比较优化，非加密用途
function fastHash(str) {
    if (!str) return "0";
    
    // 使用FNV-1a算法 - 快速且碰撞率低，适合比较目的
    const FNV_PRIME = 0x01000193;
    const FNV_OFFSET_BASIS = 0x811c9dc5;
    
    let hash = FNV_OFFSET_BASIS;
    
    // 处理完整字符串，无需采样或截断
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = (hash * FNV_PRIME) & 0xffffffff; // 保持32位精度
    }
    
    return (hash >>> 0).toString(16); // 转为无符号值并返回16进制表示
}

// 替换原来的simpleHash函数
async function simpleHash(str) {
    if (!str) return null;
    
    // 直接使用同步哈希，无需异步
    return fastHash(str);
}

// 表格抽屉观察器回调函数
const drawerObserverCallback = async function(mutationsList, observer) {
    for(const mutation of mutationsList) {
        if (mutation.type === 'attributes' && mutation.attributeName === 'style') {
            const tableDrawerContent = mutation.target;
            const currentDisplayState = window.getComputedStyle(tableDrawerContent).display;

            // --- 抽屉打开逻辑 ---
            if (currentDisplayState !== 'none' && metadataHashOnDrawerOpen === null) {
                logDebug('[聊天自动备份] 表格抽屉已打开。获取初始 chatMetadata 哈希...');
                const context = getContext();
                if (context && context.chatMetadata) {
                    try {
                        // 处理完整元数据
                        const metadataString = JSON.stringify(context.chatMetadata);
                        // 使用同步哈希函数无需await
                        metadataHashOnDrawerOpen = fastHash(metadataString);
                        logDebug(`[聊天自动备份] 抽屉打开时 chatMetadata 哈希: ${metadataHashOnDrawerOpen}`);
                    } catch (e) {
                        console.error('[聊天自动备份] 计算抽屉打开时元数据哈希失败:', e);
                        metadataHashOnDrawerOpen = 'error_on_open';
                    }
                } else {
                    logDebug('[聊天自动备份] 抽屉打开时 chatMetadata 不存在，将强制备份');
                    metadataHashOnDrawerOpen = null; // 确保关闭时会因 previousHash 为 null 而备份
                }
            }
            // --- 抽屉关闭逻辑 ---
            else if (currentDisplayState === 'none' && metadataHashOnDrawerOpen !== null && metadataHashOnDrawerOpen !== 'closing_in_progress') {
                logDebug('[聊天自动备份] 表格抽屉已关闭。检查 chatMetadata 是否变化...');
                const previousHash = metadataHashOnDrawerOpen;
                // 立即将标志设置为处理中，防止重复触发
                metadataHashOnDrawerOpen = 'closing_in_progress'; // 防止动画期间重复触发
                
                const context = getContext();
                let currentMetadataHash = null;
                if (context && context.chatMetadata) {
                    try {
                        const metadataString = JSON.stringify(context.chatMetadata);
                        // 使用同步哈希函数
                        currentMetadataHash = fastHash(metadataString);
                        logDebug(`[聊天自动备份] 抽屉关闭时 chatMetadata 哈希: ${currentMetadataHash}`);
                    } catch (e) {
                        console.error('[聊天自动备份] 计算抽屉关闭时元数据哈希失败:', e);
                        currentMetadataHash = 'error_on_close';
                    }
                } else {
                    logDebug('[聊天自动备份] 抽屉关闭时 chatMetadata 不存在');
                }

                // 检查元数据是否变化
                if (previousHash === null || previousHash === 'error_on_open' || 
                    currentMetadataHash === 'error_on_close' || previousHash !== currentMetadataHash) {
                    
                    logDebug(`[聊天自动备份] chatMetadata 发生变化 (打开时: ${previousHash}, 关闭时: ${currentMetadataHash}) 或初始状态未知，准备触发备份。`);
                    
                    // 检查当前是否有正在执行的备份，避免冲突
                    if (!isBackupInProgress) {
                        logDebug('[聊天自动备份] 没有进行中的备份，执行表格元数据变化导致的立即备份');
                        // 使用 false 参数 - 不强制保存，不需要轮询
                        performBackupConditional(BACKUP_TYPE.STANDARD, true).catch(error => {
                            console.error('[聊天自动备份] 表格抽屉关闭事件触发的备份失败:', error);
                        });
                    } else {
                        logDebug('[聊天自动备份] 已有备份进行中，跳过表格元数据变化导致的备份');
                    }
                } else {
                    logDebug('[聊天自动备份] chatMetadata 哈希值一致，不触发备份。');
                }
                
                // 等待一段时间后才重置，防止多次触发关闭处理
                setTimeout(() => {
                    metadataHashOnDrawerOpen = null; // 为下一次打开重置
                    logDebug('[聊天自动备份] 抽屉关闭处理完毕，重置哈希状态');
                }, 500);
            }
        }
    }
};

// --- API 交互辅助函数 ---

/**
 * 获取指定群组聊天文件的消息内容 (消息数组)
 * 注意：此API通常只返回消息，元数据需从群组对象获取
 * @param {string} groupId - 群组ID
 * @param {string} groupChatId - 群组聊天ID (文件名，不带 .jsonl)
 * @returns {Promise<Array|null>} 返回消息数组，或在失败时返回null
 */
async function fetchGroupChatMessages(groupId, groupChatId) {
    logDebug(`[API] 正在获取群组 "${groupId}" 的聊天 "${groupChatId}.jsonl" 消息内容...`);
    // 新增：AbortController 超时中断
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const response = await fetch('/api/chats/group/get', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ id: groupId, chat_id: groupChatId }),
            signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`获取群组聊天消息API失败: ${response.status} - ${errorText}`);
        }
        const messagesArray = await response.json();
        logDebug(`[API] 成功获取群组 "${groupId}" 的聊天 "${groupChatId}.jsonl" 消息，消息数: ${messagesArray.length}`);
        return messagesArray;
    } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            console.error('[API] fetchGroupChatMessages 请求超时:', error);
            toastr.error('请求超时：获取群组聊天消息失败', '恢复失败');
        } else {
            console.error(`[API] fetchGroupChatMessages 错误:`, error);
        }
        return null;
    }
}


/**
 * 通过流式读取，仅获取聊天文件的第一行（元数据）就中断请求。
 * @param {string} characterName - 角色名称
 * @param {string} chatFileName - 聊天文件名 (不带 .jsonl)
 * @param {string} avatarFileName - 角色头像文件名
 * @returns {Promise<object|null>} 返回元数据对象，或在失败时返回null
 */
async function fetchChatMetadataOnly(characterName, chatFileName, avatarFileName) {
    logDebug(`[API-Stream] 正在尝试流式获取角色 "${characterName}" 的聊天文件 "${chatFileName}.jsonl" 的元数据...`);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
        const response = await fetch('/api/chats/get', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ ch_name: characterName, file_name: chatFileName, avatar_url: avatarFileName }),
            signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!response.ok || !response.body) {
            const errorText = await response.text();
            throw new Error(`获取聊天元数据流API失败: ${response.status} - ${errorText}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let metadata = null;

        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                if (buffer.length > 0) try { metadata = JSON.parse(buffer); } catch (e) {}
                break;
            }
            buffer += decoder.decode(value, { stream: true });
            const newlineIndex = buffer.indexOf('\n');
            if (newlineIndex !== -1) {
                const metadataLine = buffer.substring(0, newlineIndex);
                try {
                    metadata = JSON.parse(metadataLine);
                    await reader.cancel();
                } catch (e) {
                    console.error('[API-Stream] 解析元数据行失败:', e);
                    await reader.cancel();
                }
                break;
            }
        }
        if (!metadata) throw new Error('未能从流中解析出元数据。');
        return metadata;
    } catch (error) {
        clearTimeout(timeoutId);
        console.error(`[API-Stream] fetchChatMetadataOnly 错误:`, error);
        return null;
    }
}

/**
 * 将聊天元数据和消息数组构造成 .jsonl 格式的字符串
 * @param {object} metadata - 聊天元数据对象
 * @param {Array} messages - 聊天消息对象数组
 * @returns {string} .jsonl 格式的字符串
 */
function constructJsonlString(metadata, messages) {
    if (!metadata || !Array.isArray(messages)) {
        console.error('[CONSTRUCT] 无效的元数据或消息数组传入 constructJsonlString');
        return '';
    }
    
    // 使用 join 方法，性能更好
    const lines = new Array(messages.length + 1);
    lines[0] = JSON.stringify(metadata);
    
    for (let i = 0; i < messages.length; i++) {
        lines[i + 1] = JSON.stringify(messages[i]);
    }
    
    // 注意：最后的 \n 是必需的，符合 JSONL 规范
    return lines.join('\n') + '\n';
}

// 扩展名和设置初始化
const PLUGIN_NAME = 'chat-history-backup';
const DEFAULT_SETTINGS = {
    maxEntityCount: 5,        // 最多保存几个不同角色/群组的备份 (新增)
    maxBackupsPerEntity: 3,   // 每个角色/群组最多保存几个备份 (新增)
    backupDebounceDelay: 1500, // 防抖延迟时间 (毫秒)
    debug: false, // 调试模式
    restoreChatTimeout: 3000,    // 等待聊天文件识别的超时(ms)
    restoreContextTimeout: 3000, // 等待上下文切换的超时(ms)
};

// IndexedDB 数据库名称和版本
const DB_NAME = 'ST_ChatBackup';
const DB_VERSION = 2; 
const META_STORE_NAME = 'backups_meta';
const CONTENT_STORE_NAME = 'backups_content';

// JSONL 解析器 Web Worker 实例
let jsonlParserWorker = null;
// 用于追踪解析器 Worker 请求的 Promise
const parserWorkerPromises = {};
let parserWorkerRequestId = 0;

// 数据库连接池 - 实现单例模式
let dbConnection = null;



// --- 日志函数 ---
function logDebug(...args) {
    // 强制禁用日志输出 - 调试功能已完全禁用
    return;
    // 原始调试代码已被注释
    /*
    const settings = extension_settings[PLUGIN_NAME];
    if (settings && settings.debug) {
        // 使用 console.log 来实际输出日志
        console.log(`[聊天自动备份][${new Date().toLocaleTimeString()}]`, ...args);
    }
    */
}

// --- JSONL 解析器 Web Worker ---
const jsonlParserLogicString = `\
// JSONL 解析器 Worker 消息处理器
self.onmessage = function(e) {
    const { id, jsonlString, options } = e.data;
    if (!jsonlString) {
        self.postMessage({ id, error: 'Invalid JSONL string received by parser worker' });
        return;
    }
    try {
        let result;

        // --- 新增分支：处理从 API 获取的完整JSON数组字符串 ---
        if (options.parseJsonArrayString) {
            const fullArray = JSON.parse(jsonlString); // 在Worker中执行重量级解析
            const messages = fullArray.slice(1);

            // ★ 关键：只返回轻量级的元数据和用于重构的完整数组
            result = {
                messageCount: messages.length,
                lastTwoMessages: messages.slice(-2),
                fullParsedArray: fullArray // 用于主线程重构jsonl
            };
        }
        // --- 原有处理 .jsonl 文件的逻辑保持不变 ---
        else {
            // 按换行符分割JSONL字符串
            const lines = jsonlString.trim().split('\\n');

            if (options.parseFull) {
                // 完整解析 - 用于恢复
                result = lines.map(line => JSON.parse(line));
            } else if (options.lastNMessages) {
                // 解析最后N条消息 - 用于预览
                const lastLines = lines.slice(-options.lastNMessages);
                result = lastLines.map(line => JSON.parse(line));
            } else {
                // 默认解析最后一条消息
                const lastLine = lines[lines.length - 1];
                result = lastLine ? [JSON.parse(lastLine)] : [];
            }
        }

        self.postMessage({ id, result });
    } catch (error) {
        console.error('[JSONL Parser Worker] Error during parsing for ID:', id, error);
        self.postMessage({ id, error: error.message || 'JSONL parsing failed' });
    }
};`;

// JSONL 解析器 Web Worker 通信函数
function parseJsonlInWorker(jsonlString, options = {}) {
    return new Promise((resolve, reject) => {
        if (!jsonlParserWorker) {
            return reject(new Error("JSONL parser worker not initialized."));
        }

        const currentRequestId = ++parserWorkerRequestId;
        parserWorkerPromises[currentRequestId] = { resolve, reject };

        logDebug(`[JSONL Parser] 发送数据到 Worker (ID: ${currentRequestId}), String size: ${jsonlString.length}`);
        try {
            jsonlParserWorker.postMessage({
                id: currentRequestId,
                jsonlString: jsonlString,
                options: options
            });
        } catch (error) {
            console.error(`[JSONL Parser] 发送消息到 Worker 失败 (ID: ${currentRequestId}):`, error);
            delete parserWorkerPromises[currentRequestId];
            reject(error);
        }
    });
}

// --- 设置初始化 ---
function initSettings() {
    logDebug('[聊天自动备份] 初始化插件设置');
    if (!extension_settings[PLUGIN_NAME]) {
        logDebug('[聊天自动备份] 创建新的插件设置');
        extension_settings[PLUGIN_NAME] = { ...DEFAULT_SETTINGS };
    }

    const settings = extension_settings[PLUGIN_NAME];

    // 确保所有设置存在并有默认值
    settings.maxEntityCount = settings.maxEntityCount ?? DEFAULT_SETTINGS.maxEntityCount;
    settings.maxBackupsPerEntity = settings.maxBackupsPerEntity ?? DEFAULT_SETTINGS.maxBackupsPerEntity;
    settings.backupDebounceDelay = settings.backupDebounceDelay ?? DEFAULT_SETTINGS.backupDebounceDelay;
    settings.debug = false;
    settings.restoreChatTimeout = settings.restoreChatTimeout ?? DEFAULT_SETTINGS.restoreChatTimeout;
    settings.restoreContextTimeout = settings.restoreContextTimeout ?? DEFAULT_SETTINGS.restoreContextTimeout;

    // 验证设置合理性
    if (typeof settings.maxEntityCount !== 'number' || settings.maxEntityCount < 1 || settings.maxEntityCount > 10) {
        console.warn(`[聊天自动备份] 无效的最大角色/群组数 ${settings.maxEntityCount}，重置为默认值 ${DEFAULT_SETTINGS.maxEntityCount}`);
        settings.maxEntityCount = DEFAULT_SETTINGS.maxEntityCount;
    }

    if (typeof settings.maxBackupsPerEntity !== 'number' || settings.maxBackupsPerEntity < 1 || settings.maxBackupsPerEntity > 10) {
        console.warn(`[聊天自动备份] 无效的每角色/群组最大备份数 ${settings.maxBackupsPerEntity}，重置为默认值 ${DEFAULT_SETTINGS.maxBackupsPerEntity}`);
        settings.maxBackupsPerEntity = DEFAULT_SETTINGS.maxBackupsPerEntity;
    }

    if (typeof settings.backupDebounceDelay !== 'number' || settings.backupDebounceDelay < 300 || settings.backupDebounceDelay > 30000) {
        console.warn(`[聊天自动备份] 无效的防抖延迟 ${settings.backupDebounceDelay}，重置为默认值 ${DEFAULT_SETTINGS.backupDebounceDelay}`);
        settings.backupDebounceDelay = DEFAULT_SETTINGS.backupDebounceDelay;
    }

    logDebug('[聊天自动备份] 插件设置初始化完成:', settings);
    return settings;
}

// --- IndexedDB 相关函数 ---
function initDatabase() {
    return new Promise((resolve, reject) => {
        logDebug('初始化 IndexedDB 数据库');
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = function(event) {
            console.error('[聊天自动备份] 打开数据库失败:', event.target.error);
            reject(event.target.error);
        };

        request.onsuccess = function(event) {
            const db = event.target.result;

            // 当别的上下文要升级/删除本库时，老连接会收到 versionchange，务必尽快关闭并清空缓存
            db.onversionchange = () => {
                console.warn('[BackupDB] versionchange -> closing current connection');
                try { db.close(); } catch {}
                if (dbConnection === db) dbConnection = null;
            };

            // 有些浏览器实现了 onclose：收到就清空缓存，便于后续重开
            db.onclose = () => {
                console.warn('[BackupDB] onclose -> reset cached connection');
                if (dbConnection === db) dbConnection = null;
            };

            logDebug('数据库打开成功');
            resolve(db);
        };

        request.onupgradeneeded = function(event) {
            const db = event.target.result;
            logDebug('[聊天自动备份] 数据库升级中...');

            // 从旧版本升级时，先删除旧的 store
            if (db.objectStoreNames.contains('backups')) {
                db.deleteObjectStore('backups');
                logDebug('[聊天自动备份] 已删除旧的 "backups" 存储');
            }

            // 创建新的元数据存储
            if (!db.objectStoreNames.contains(META_STORE_NAME)) {
                const metaStore = db.createObjectStore(META_STORE_NAME, { keyPath: ['chatKey', 'timestamp'] });
                metaStore.createIndex('chatKey', 'chatKey', { unique: false });
                metaStore.createIndex('entityName', 'entityName', { unique: false }); // 为按实体清理添加索引
                logDebug('[聊天自动备份] 创建了元数据存储 (backups_meta) 和索引');
            }

            // 创建新的内容存储
            if (!db.objectStoreNames.contains(CONTENT_STORE_NAME)) {
                // keyPath 必须与元数据存储保持一致，以便关联
                db.createObjectStore(CONTENT_STORE_NAME, { keyPath: ['chatKey', 'timestamp'] });
                logDebug('[聊天自动备份] 创建了内容存储 (backups_content)');
            }
        };

        // 可选：被阻塞时给出日志，便于排查
        request.onblocked = () => {
            console.warn('[BackupDB] open request is blocked by another connection holding the DB');
        };
    });
}

// 获取数据库连接 (优化版本 - 使用连接池)
async function getDB() {
    // 如果有缓存连接，先做一次轻量探测：开个只读事务；若抛 InvalidState/closing 则重开
    if (dbConnection) {
        try {
            dbConnection.transaction([META_STORE_NAME], 'readonly'); // probe
            return dbConnection; // 正常可用
        } catch (e) {
            // 连接处于 closing/closed，会在这里抛错
            console.warn('[BackupDB] cached connection is not usable, reopening…', e);
            try { dbConnection.close?.(); } catch {}
            dbConnection = null;
        }
    }
    dbConnection = await initDatabase();
    return dbConnection;
}

// 为所有 DB 操作加"失败重试（遇到 closing 则重开）
async function withDB(op, retries = 3) {
    for (let i = 0; i <= retries; i++) {
        const db = await getDB();
        try {
            return await op(db);
        } catch (e) {
            const msg = String(e?.message || '');
            const isClosing = e?.name === 'InvalidStateError' || msg.includes('closing');
            if (isClosing && i < retries) {
                try { db.close?.(); } catch {}
                dbConnection = null;
                await new Promise(r => setTimeout(r, 50 * (i + 1))); // 线性小退避
                continue;
            }
            throw e;
        }
    }
}

// 保存备份到 IndexedDB (重构版 - 分离元数据和内容)
async function saveBackupToDB(backupMeta, backupContent) {
    return withDB(async (db) => {
        await new Promise((resolve, reject) => {
            // 使用新的存储名称
            const tx = db.transaction([META_STORE_NAME, CONTENT_STORE_NAME], 'readwrite');
            tx.oncomplete = resolve;
            tx.onerror = (ev) => reject(ev.target.error);
            tx.onabort  = (ev) => reject(ev.target.error);

            // 存入元数据
            tx.objectStore(META_STORE_NAME).put(backupMeta);
            // 存入内容
            tx.objectStore(CONTENT_STORE_NAME).put(backupContent);
        });
    });
}


// 从 IndexedDB 获取所有备份的元数据 (轻量级！)
async function getAllBackupsMeta() {
    return withDB(async (db) => {
        return await new Promise((resolve, reject) => {
            const transaction = db.transaction([META_STORE_NAME], 'readonly');
            const store = transaction.objectStore(META_STORE_NAME);
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = (event) => reject(event.target.error);
        });
    });
}

// 获取单个备份的完整数据 (元数据+内容)
async function getFullBackup(chatKey, timestamp) {
    return withDB(async (db) => {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction([META_STORE_NAME, CONTENT_STORE_NAME], 'readonly');
            let meta, content;

            tx.oncomplete = () => {
                if (meta && content) {
                    // 合并成旧格式，方便其他函数调用 (内容现在是字符串)
                    resolve({ ...meta, chatFileContent: content.chatFileContent });
                } else {
                    resolve(null); // 任一数据不存在则返回null
                }
            };
            tx.onerror = (ev) => reject(ev.target.error);

            const key = [chatKey, timestamp];
            tx.objectStore(META_STORE_NAME).get(key).onsuccess = (e) => meta = e.target.result;
            tx.objectStore(CONTENT_STORE_NAME).get(key).onsuccess = (e) => content = e.target.result;
        });
    });
} 

// 从 IndexedDB 删除指定备份 (重构版)
async function deleteBackup(chatKey, timestamp) {
    return withDB(async (db) => {
        await new Promise((resolve, reject) => {
            const transaction = db.transaction([META_STORE_NAME, CONTENT_STORE_NAME], 'readwrite');
            transaction.oncomplete = () => {
                logDebug(`已从IndexedDB删除备份, 键: [${chatKey}, ${timestamp}]`);
                resolve();
            };
            transaction.onerror = (event) => reject(event.target.error);

            const key = [chatKey, timestamp];
            transaction.objectStore(META_STORE_NAME).delete(key);
            transaction.objectStore(CONTENT_STORE_NAME).delete(key);
        });
    });
}

// 获取单个备份的元数据
async function getBackupMeta(chatKey, timestamp) {
    return withDB(async (db) => {
        return await new Promise((resolve, reject) => {
            const transaction = db.transaction([META_STORE_NAME], 'readonly');
            const store = transaction.objectStore(META_STORE_NAME);
            const request = store.get([chatKey, timestamp]);
            request.onsuccess = () => resolve(request.result);
            request.onerror = (event) => reject(event.target.error);
        });
    });
}


// --- 聊天信息获取 ---
function getCurrentChatKey() {
    const context = getContext();
    logDebug('获取当前聊天标识符, context:',
        {groupId: context.groupId, characterId: context.characterId, chatId: context.chatId});
    if (context.groupId) {
        const key = `group_${context.groupId}_${context.chatId}`;
        logDebug('当前是群组聊天，chatKey:', key);
        return key;
    } else if (context.characterId !== undefined && context.chatId) { // 确保chatId存在
        const key = `char_${context.characterId}_${context.chatId}`;
        logDebug('当前是角色聊天，chatKey:', key);
        return key;
    }
    console.warn('[聊天自动备份] 无法获取当前聊天的有效标识符 (可能未选择角色/群组或聊天)');
    return null;
}

function getCurrentChatInfo() {
    const context = getContext();
    let chatName = '当前聊天', entityName = '未知';

    if (context.groupId) {
        const group = context.groups?.find(g => g.id === context.groupId);
        entityName = group ? group.name : `群组 ${context.groupId}`;
        chatName = context.chatId || '新聊天'; // 使用更明确的默认名
        logDebug('获取到群组聊天信息:', {entityName, chatName});
    } else if (context.characterId !== undefined) {
        entityName = context.name2 || `角色 ${context.characterId}`;
        const character = context.characters?.[context.characterId];
        if (character && context.chatId) {
             // chat文件名可能包含路径，只取最后一部分
             const chatFile = character.chat || context.chatId;
             chatName = chatFile.substring(chatFile.lastIndexOf('/') + 1).replace('.jsonl', '');
        } else {
            chatName = context.chatId || '新聊天';
        }
        logDebug('获取到角色聊天信息:', {entityName, chatName});
    } else {
        console.warn('[聊天自动备份] 无法获取聊天实体信息，使用默认值');
    }

    return { entityName, chatName };
}


// --- 核心备份逻辑封装 (文本流处理) ---
async function executeBackupLogic_Core(settings, backupType = BACKUP_TYPE.STANDARD, attemptId, forceSave = false) {
    logDebug(`[Backup #${attemptId.toString().slice(-6)}] executeBackupLogic_Core started. Type: ${backupType}, ForceSave: ${forceSave}`);

    if (isBackupInProgress) {
        logDebug(`[Backup #${attemptId.toString().slice(-6)}] Core logic busy. Aborting.`);
        return false;
    }
    isBackupInProgress = true;
    logDebug(`[Backup #${attemptId.toString().slice(-6)}] Acquired lock.`);

    try {
        const currentTimestamp = Date.now();
        const chatKey = getCurrentChatKey();
        if (!chatKey) {
            console.warn(`[Backup #${attemptId.toString().slice(-6)}] No valid chat key.`);
            return false;
        }

        const { entityName, chatName } = getCurrentChatInfo();

        // ★ 关键修正：在函数作用域顶部声明所有需要跨分支使用的变量
        let jsonlString = null;
        let originalChatMessagesCount = 0;
        let lastTwoMessages = [];
        let lastMessagePreview = '(Empty chat)';
        let lastMsgIndex = -1;

        logDebug(`[Backup #${attemptId.toString().slice(-6)}] Backing up: ${entityName} - ${chatName}`);

        // --- 策略分支：强制保存时先进行元数据轮询 ---
        if (forceSave) {
            logDebug(`[Backup #${attemptId.toString().slice(-6)}] Using ForceSave strategy, starting metadata polling...`);
            const MAX_POLL_ATTEMPTS = 2;
            const POLL_INTERVAL_MS = 350;
            let isSynced = false;

            for (let pollAttempts = 1; pollAttempts <= MAX_POLL_ATTEMPTS; pollAttempts++) {
                if (currentBackupAttemptId !== attemptId) {
                    logDebug(`[Backup #${attemptId.toString().slice(-6)}] Cancelled during polling loop.`);
                    return false;
                }
                logDebug(`[Backup #${attemptId.toString().slice(-6)}] Polling attempt #${pollAttempts}...`);

                try {
                    const clientContext = getContext();
                    let serverMetadata = null;

                    if (clientContext.groupId) {
                        serverMetadata = clientContext.chatMetadata || {};
                        isSynced = true;
                    } else if (clientContext.characterId !== undefined) {
                        const character = characters[clientContext.characterId];
                        const effectiveCharChatFile = character?.chat || clientContext.chatId;
                        if (!effectiveCharChatFile) throw new Error("Character chat file not found for polling.");

                        serverMetadata = await fetchChatMetadataOnly(character.name, effectiveCharChatFile, character.avatar);
                        const clientMetadata = clientContext.chatMetadata || {};

                        if (JSON.stringify(serverMetadata) === JSON.stringify(clientMetadata)) {
                            isSynced = true;
                        }
                    }

                    if (isSynced) {
                        logDebug(`[Backup #${attemptId.toString().slice(-6)}] Synced after ${pollAttempts} attempt(s).`);
                        break;
                    }

                } catch (pollError) {
                    console.error(`[Backup #${attemptId.toString().slice(-6)}] Error polling (attempt #${pollAttempts}):`, pollError);
                }

                if (pollAttempts < MAX_POLL_ATTEMPTS) {
                    logDebug(`[Backup #${attemptId.toString().slice(-6)}] Not synced, waiting ${POLL_INTERVAL_MS}ms...`);
                    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
                }
            }

            if (!isSynced) {
                logDebug(`[Backup #${attemptId.toString().slice(-6)}] NOT synced after ${MAX_POLL_ATTEMPTS} attempts. Continuing with backup anyway.`);
            }
        }

        // --- 统一的数据获取与处理逻辑 ---
        try {
            const context = getContext();
            if (context.groupId) {
                const group = context.groups?.find(g => g.id === context.groupId);
                const effectiveGroupChatId = group?.chat_id || context.chatId;
                if (!effectiveGroupChatId) throw new Error(`Group chat ID not found`);

                const messagesFromAPI = await fetchGroupChatMessages(group.id, effectiveGroupChatId);
                if (!messagesFromAPI) throw new Error("API for group messages returned null");

                const serverChatMetadata = structuredClone(context.chatMetadata || {});
                jsonlString = constructJsonlString(serverChatMetadata, messagesFromAPI);
                originalChatMessagesCount = messagesFromAPI.length;

                // ★ 关键修正：为群组聊天路径计算所有必要的变量
                lastTwoMessages = messagesFromAPI.slice(-2);
                lastMsgIndex = originalChatMessagesCount > 0 ? originalChatMessagesCount - 1 : -1;
                const lastMessage = lastTwoMessages.length > 0 ? lastTwoMessages[lastTwoMessages.length - 1] : null;
                if (originalChatMessagesCount > 0) {
                    const fullMessageText = lastMessage?.mes || '';
                    lastMessagePreview = !fullMessageText ? '(Message content retrieval failed)' : filterSpecialTags(fullMessageText).substring(0, 150);
                }

            } else if (context.characterId !== undefined) {
                const character = characters[context.characterId];
                const effectiveCharChatFile = character?.chat || context.chatId;
                if (!effectiveCharChatFile) throw new Error(`Character chat file not found`);

                const response = await fetch('/api/chats/get', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({ ch_name: character.name, file_name: effectiveCharChatFile, avatar_url: character.avatar }),
                });

                if (!response.ok) throw new Error(`Get chat content API failed: ${response.status}`);

                const rawJsonArrayString = await response.text();
                logDebug(`[Backup #${attemptId.toString().slice(-6)}] Got raw JSON array string, size: ${Math.round(rawJsonArrayString.length / 1024)} KB.`);

                if (!jsonlParserWorker) throw new Error("JSONL parser worker is not available.");

                const workerResult = await parseJsonlInWorker(rawJsonArrayString, { parseJsonArrayString: true });

                // 将 Worker 返回的结果赋值给顶层作用域的变量
                originalChatMessagesCount = workerResult.messageCount;
                lastTwoMessages = workerResult.lastTwoMessages;
                const fullParsedArray = workerResult.fullParsedArray;
                jsonlString = constructJsonlString(fullParsedArray[0], fullParsedArray.slice(1));

                lastMsgIndex = originalChatMessagesCount > 0 ? originalChatMessagesCount - 1 : -1;
                const lastMessage = lastTwoMessages.length > 0 ? lastTwoMessages[lastTwoMessages.length - 1] : null;
                if (originalChatMessagesCount > 0) {
                    const fullMessageText = lastMessage?.mes || '';
                    lastMessagePreview = !fullMessageText ? '(Message content retrieval failed)' : filterSpecialTags(fullMessageText).substring(0, 150);
                }

            } else {
                throw new Error("Cannot determine entity type to get chat content.");
            }
        } catch (error) {
            console.error(`[Backup #${attemptId.toString().slice(-6)}] Failed to get chat data:`, error);
            toastr.error(`Backup failed: ${error.message || 'Error getting data'}`, 'Chat Auto Backup');
            return false;
        }

        if (!jsonlString) {
            console.error(`[Backup #${attemptId.toString().slice(-6)}] Failed to get a valid chat content string.`);
            return false;
        }

        logDebug(`[Backup #${attemptId.toString().slice(-6)}] Got chat content as text, size: ${Math.round(jsonlString.length / 1024)} KB.`);

        // 移除所有冗余的计算逻辑。所有变量至此都已准备就绪。

        // 创建元数据和内容对象
        const key = { chatKey, timestamp: currentTimestamp };
        const backupMeta = {
            ...key, entityName, chatName,
            lastMessageId: lastMsgIndex,
            lastMessagePreview,
            lastTwoMessages: lastTwoMessages,
        };
        const backupContent = {
            ...key,
            chatFileContent: jsonlString,
        };

        logDebug(`[Backup #${attemptId.toString().slice(-6)}] Built backup metadata:`, { ...backupMeta, lastTwoMessages: `${backupMeta.lastTwoMessages.length} messages` });

        await saveBackupToDB(backupMeta, backupContent);
        logDebug(`[Backup #${attemptId.toString().slice(-6)}] New backup saved.`);

        // --- 清理逻辑 ---
        let allMetas = await getAllBackupsMeta();
        const currentEntityBackups = allMetas.filter(m => m.entityName === entityName);
        if (currentEntityBackups.length > settings.maxBackupsPerEntity) {
            currentEntityBackups.sort((a, b) => a.timestamp - b.timestamp);
            const toDelete = currentEntityBackups.slice(0, currentEntityBackups.length - settings.maxBackupsPerEntity);
            const timestampsToDelete = new Set(toDelete.map(b => b.timestamp));
            for (const backupToDelete of toDelete) {
                await deleteBackup(backupToDelete.chatKey, backupToDelete.timestamp);
            }
            allMetas = allMetas.filter(m => !timestampsToDelete.has(m.timestamp));
        }

        const freshMetas = await getAllBackupsMeta();
        const entityMap = new Map();
        freshMetas.forEach(meta => {
            if (!entityMap.has(meta.entityName)) entityMap.set(meta.entityName, []);
            entityMap.get(meta.entityName).push(meta);
        });

        if (entityMap.size > settings.maxEntityCount) {
            const sortedEntities = Array.from(entityMap.values())
                .sort((a, b) => Math.max(...b.map(m => m.timestamp)) - Math.max(...a.map(m => m.timestamp)));
            const entitiesToRemove = sortedEntities.slice(settings.maxEntityCount);
            for (const entityBackups of entitiesToRemove) {
                for (const backupToDelete of entityBackups) {
                    await deleteBackup(backupToDelete.chatKey, backupToDelete.timestamp);
                }
            }
        }

        logDebug(`[Backup #${attemptId.toString().slice(-6)}] Backup and cleanup successful.`);
        return true;
    } catch (error) {
        console.error(`[Backup #${attemptId.toString().slice(-6)}] Error during backup/cleanup:`, error);
        throw error;
    } finally {
        isBackupInProgress = false;
        logDebug(`[Backup #${attemptId.toString().slice(-6)}] Released lock.`);
    }
}

async function performBackupConditional(backupType = BACKUP_TYPE.STANDARD, forceSave = false) {
    const localAttemptId = Date.now() + Math.random(); // 增加随机数确保唯一性
    currentBackupAttemptId = localAttemptId; 
    logDebug(`[Backup #${localAttemptId.toString().slice(-6)}] performBackupConditional called. Type: ${backupType}, ForceSave: ${forceSave}`);

    const currentSettings = extension_settings[PLUGIN_NAME];
    if (!currentSettings) {
        console.error('[聊天自动备份] Could not get current settings, cancelling backup');
        return false;
    }

    const chatKey = getCurrentChatKey();
    if (!chatKey) {
        logDebug(`[Backup #${localAttemptId.toString().slice(-6)}] Could not get a valid chat identifier, cancelling backup`);
        return false;
    }
    
    try {
        // 仅在forceSave为true时调用saveChatConditional
        if (forceSave) {
            logDebug(`[Backup #${localAttemptId.toString().slice(-6)}] Force saving chat...`);
            await saveChatConditional();
            logDebug(`[Backup #${localAttemptId.toString().slice(-6)}] saveChatConditional completed.`);
        } else {
            logDebug(`[Backup #${localAttemptId.toString().slice(-6)}] Skipping force save.`);
        }

        // 在调用轮询核心前再次检查是否已被取消
        if (currentBackupAttemptId !== localAttemptId) {
            logDebug(`[Backup #${localAttemptId.toString().slice(-6)}] Cancelled before calling executeBackupLogic_Core.`);
            return false; 
        }
        
        // 传递forceSave参数
        const success = await executeBackupLogic_Core(currentSettings, backupType, localAttemptId, forceSave);
        
        if (success) {
            await updateBackupsList();
        }
        return success;
    } catch (error) {
        console.error(`[Backup #${localAttemptId.toString().slice(-6)}] Conditional backup execution failed:`, error);
        toastr.error(`备份失败: ${error.message || 'Unknown error'}`, '聊天自动备份');
        return false;
    }
}

// 在高频写入场景里做"温和节流 + 空闲时提交"
function scheduleIdle(fn) {
    if (window.requestIdleCallback) return requestIdleCallback(() => fn());
    return setTimeout(fn, 0);
}

// --- Debounced backup function (similar to saveChatDebounced) ---
function performBackupDebounced(backupType = BACKUP_TYPE.STANDARD) {
    // Get the context and settings at the time of scheduling
    const scheduledChatKey = getCurrentChatKey();
    const currentSettings = extension_settings[PLUGIN_NAME];

    if (!scheduledChatKey) {
        logDebug('Could not get ChatKey at the time of scheduling debounced backup, cancelling');
        clearTimeout(backupTimeout);
        backupTimeout = null;
        return;
    }

    if (!currentSettings || typeof currentSettings.backupDebounceDelay !== 'number') {
        console.error('[聊天自动备份] Could not get valid debounce delay setting, cancelling debounced backup');
        clearTimeout(backupTimeout);
        backupTimeout = null;
        return;
    }

    // 后台标签页适当加大防抖时间
    const base = currentSettings.backupDebounceDelay;
    const delay = document.visibilityState === 'hidden' ? Math.max(base, 2500) : base;

    logDebug(`Scheduling debounced backup (delay ${delay}ms), for ChatKey: ${scheduledChatKey}, Type: ${backupType}`);
    clearTimeout(backupTimeout); // Clear the old timer

    backupTimeout = setTimeout(async () => {
        const currentChatKey = getCurrentChatKey(); // Get the ChatKey at the time of execution

        // Crucial: Context check
        if (currentChatKey !== scheduledChatKey) {
            logDebug(`Context has changed (Current: ${currentChatKey}, Scheduled: ${scheduledChatKey}), cancelling this debounced backup`);
            backupTimeout = null;
            return; // Abort backup
        }

        logDebug(`Executing delayed backup operation (from debounce), ChatKey: ${currentChatKey}, Type: ${backupType}`);
        // 防抖备份不强制保存
        await performBackupConditional(backupType, false).catch(error => {
            console.error(`[聊天自动备份] 防抖备份事件 ${currentChatKey} 处理失败:`, error);
        });
        backupTimeout = null; // Clear the timer ID
    }, delay);
}

// --- Manual backup ---
async function performManualBackup() {
    logDebug('[聊天自动备份] Performing manual backup (calling conditional function)');
    try {
         await performBackupConditional(BACKUP_TYPE.STANDARD, true); // 手动备份使用强制保存
         toastr.success('备份成功！', '聊天自动备份');
    } catch (error) {
         console.error('[聊天自动备份] Manual backup failed:', error);
    }
}

// --- 恢复逻辑 ---

/**
 * [新增辅助函数] 等待，直到指定的聊天文件出现在角色的聊天列表中。
 * @param {number} charId 角色索引
 * @param {string} chatFileNameToFind 要查找的聊天文件名 (不含.jsonl)
 * @param {number} timeout 超时时间 (毫秒)
 * @returns {Promise<void>}
 */
async function waitForChatFile(charId, chatFileNameToFind, timeout = null) {
    const t = timeout ?? extension_settings[PLUGIN_NAME].restoreChatTimeout;
    logDebug(`[恢复流程] 等待聊天文件 "${chatFileNameToFind}" 被识别 (超时 ${t}ms)…`);
    await waitUntilCondition(
        async () => {
            const chats = await getPastCharacterChats(charId);
            return chats.some(c => c.file_name.replace('.jsonl','') === chatFileNameToFind);
        },
        t,
        200
    ).catch(err => {
        const uiMsg = `等待超时：未检测到聊天文件 "${chatFileNameToFind}" 被识别`;
        // 2) 超时时给出手动切换提示
        toastr.error(`${uiMsg}。请手动切换到该角色的任意聊天后，再尝试恢复。`, '恢复失败');
        throw new Error(uiMsg);
    });
    logDebug(`[恢复流程] 聊天文件 "${chatFileNameToFind}" 已确认存在。`);
}

/**
 * [辅助函数] 等待，直到SillyTavern的上下文（Context）更新为指定状态。
 * @param {object} expectedState - 期望的上下文状态，例如 { characterId: '123', chatId: 'new_chat' }
 * @param {number} timeout - 超时时间 (毫秒)
 * @returns {Promise<void>}
 */
async function waitForContextChange(expectedState, timeout = null) {
    const t = timeout ?? extension_settings[PLUGIN_NAME].restoreContextTimeout;
    const desc = Object.entries(expectedState).map(([k,v])=>`${k}=${v}`).join(',');
    logDebug(`[恢复流程] 等待上下文更新至 (${desc}) (超时 ${t}ms)…`);
    await waitUntilCondition(
        () => {
            const ctx = getContext();
            return Object.entries(expectedState).every(([k,v])=>String(ctx[k])===String(v));
        },
        t,
        100
    ).catch(err => {
        const uiMsg = `等待超时：未检测到上下文更新至 (${desc})`;
        toastr.error(`${uiMsg}。请手动切换到目标角色并打开任意聊天后，再尝试恢复。`, '恢复失败');
        throw new Error(uiMsg);
    });
    logDebug(`[恢复流程] 上下文已成功更新至 (${desc})。`);
}


// --- 手动恢复弹窗 ---
async function showManualRestorePopup(backupData) {
    const DEBUG_PREFIX = '[手动恢复调试]';
    logDebug(`${DEBUG_PREFIX} (步骤 1) 函数开始执行。`);

    // --- (步骤 2) 创建 Popup 实例，但暂不显示 ---
    const popupContent = `
    <div id="manual_restore_popup_container">
        <style>
            #manual_restore_popup_container {
                display: flex;
                flex-direction: column;
                height: 100%;
                max-height: 70vh;
            }
            #manual_restore_search_wrapper {
                padding: 5px;
                flex-shrink: 0;
            }
            #manual_restore_search {
                width: 100%;
                padding: 8px;
                border: 1px solid #ccc;
                border-radius: 5px;
            }
            #manual_restore_char_list {
                flex-grow: 1;
                overflow-y: auto;
                border: 1px solid #ddd;
                border-radius: 5px;
                margin-top: 10px;
                background-color: rgba(0,0,0,0.05);
            }
            .manual_restore_char_item {
                display: flex;
                align-items: center;
                padding: 10px 15px;
                cursor: pointer;
                border-bottom: 1px solid #eee;
                transition: background-color 0.2s ease;
                font-size: 1.1em;
            }
            .manual_restore_char_item:last-child {
                border-bottom: none;
            }
            .manual_restore_char_item:hover {
                background-color: rgba(138, 43, 226, 0.2);
            }
            .pinned_char_item {
                background-color: rgba(255, 215, 0, 0.1);
            }
            .pinned_char_item::before {
                content: '📌';
                margin-right: 10px;
                font-size: 1.2em;
            }
            #manual_restore_status_message {
                padding: 20px;
                text-align: center;
                color: #888;
            }
            /* 为底部说明文字添加样式 */
            .manual_restore_footer_note {
                flex-shrink: 0; /* 防止在 flex 布局中被压缩 */
                margin-top: 15px;
                padding: 12px;
                background-color: rgba(128, 128, 128, 0.1);
                border-radius: 5px;
                font-size: 0.9em;
                color: #666; /* 使用柔和的灰色文字 */
                line-height: 1.5;
            }
            .manual_restore_footer_note p {
                margin: 0 0 10px 0;
            }
            .manual_restore_footer_note p:last-child {
                margin-bottom: 0;
            }
            .manual_restore_footer_note code {
                background-color: rgba(0, 0, 0, 0.2);
                padding: 2px 5px;
                border-radius: 3px;
                font-family: monospace;
                color: var(--SmText);
            }
        </style>
        <h3>选择一个角色以恢复备份</h3>
        <div id="manual_restore_search_wrapper">
            <input type="text" id="manual_restore_search" placeholder="搜索角色名称...">
        </div>
        <div id="manual_restore_char_list">
            <p id="manual_restore_status_message">正在初始化...</p>
        </div>
        
        <!-- 底部说明文字容器 -->
        <div class="manual_restore_footer_note">
            <p>该<code>手动恢复</code>功能是为了应对恢复备份时，插件错误的恢复到别的角色卡中的这种特殊情况。</p>
            <p>通常情况下，直接点击“恢复”按钮后（或者电脑使用快捷键<code>A S D</code>），插件就会自动识别正确的角色卡进行恢复备份。因此，不推荐使用<code>手动恢复</code>备份，除非插件确实将备份恢复到错误的角色卡中了。</p>
        </div>
    </div>`;

    const popup = new Popup(popupContent, POPUP_TYPE.DISPLAY, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
    });
    logDebug(`${DEBUG_PREFIX} (步骤 2) Popup 实例已在内存中创建。`);

    const charListContainer = popup.content.querySelector('#manual_restore_char_list');
    const statusMessageElement = popup.content.querySelector('#manual_restore_status_message');
    const searchInput = popup.content.querySelector('#manual_restore_search');

    if (!charListContainer || !statusMessageElement || !searchInput) {
        console.error(`${DEBUG_PREFIX} (严重错误) 无法在Popup实例中找到必要的DOM元素。`);
        return;
    }
    
    popup.show();
    logDebug(`${DEBUG_PREFIX} (步骤 4) 弹窗已显示，开始异步加载和排序数据...`);

    try {
        const context = getContext();
        let characters = context.characters;

        if (!characters || characters.length === 0) {
            statusMessageElement.textContent = '正在从服务器获取角色列表...';
            await getCharacters();
            characters = getContext().characters;
        }

        statusMessageElement.textContent = '正在整理备份信息...';

        const allMetas = await getAllBackupsMeta();
        const backedUpCharNames = new Set(
            allMetas
                .filter(meta => meta.chatKey.startsWith('char_'))
                .map(meta => meta.entityName)
        );
        logDebug(`${DEBUG_PREFIX} 找到 ${backedUpCharNames.size} 个已备份的角色。`);

        const charactersWithIndex = characters.map((char, index) => ({
            char: char,
            originalIndex: index
        }));

        charactersWithIndex.sort((a, b) => {
            const aIsBackedUp = backedUpCharNames.has(a.char.name);
            const bIsBackedUp = backedUpCharNames.has(b.char.name);

            if (aIsBackedUp && !bIsBackedUp) return -1;
            if (!aIsBackedUp && bIsBackedUp) return 1;
            return a.originalIndex - b.originalIndex;
        });

        if (characters.length > 0) {
            statusMessageElement.remove();
        } else {
            statusMessageElement.textContent = '未找到任何角色。';
        }
        
        charactersWithIndex.forEach((item) => {
            const charItem = document.createElement('div');
            charItem.className = 'manual_restore_char_item';
            charItem.dataset.charIndex = item.originalIndex;

            if (backedUpCharNames.has(item.char.name)) {
                charItem.classList.add('pinned_char_item');
            }
            
            charItem.innerHTML = `<span>${item.char.name}</span>`;
            charListContainer.appendChild(charItem);
        });
        logDebug(`${DEBUG_PREFIX} (步骤 6) UI 列表填充完成，已置顶已备份的角色。`);

        searchInput.addEventListener('input', () => {
            const searchTerm = searchInput.value.toLowerCase();
            const items = charListContainer.querySelectorAll('.manual_restore_char_item');
            items.forEach(item => {
                const name = item.querySelector('span').textContent.toLowerCase();
                item.style.display = name.includes(searchTerm) ? 'flex' : 'none';
            });
        });

        charListContainer.addEventListener('click', async (event) => {
            const targetItem = event.target.closest('.manual_restore_char_item');
            if (!targetItem) return;

            const targetCharacterIndex = parseInt(targetItem.dataset.charIndex, 10);
            const targetCharacter = characters[targetCharacterIndex];
            const backupName = `${backupData.entityName} - ${backupData.chatName}`;

            if (confirm(`确定要将备份 "${backupName}" 恢复到角色 "${targetCharacter.name}" 吗？\n\n这将在目标角色下创建一个新的聊天。`)) {
                popup.complete(POPUP_RESULT.CANCELLED);
                toastr.info(`正在将备份恢复到 "${targetCharacter.name}"...`, '手动恢复');
                closeExtensionsAndBackupUI();
                await restoreBackup(backupData, targetCharacterIndex);
            }
        });
        logDebug(`${DEBUG_PREFIX} (步骤 7) 成功绑定事件，点击逻辑不受排序影响。`);

    } catch (error) {
        console.error(`${DEBUG_PREFIX} (严重错误) 在准备弹窗内容时发生错误:`, error);
        statusMessageElement.textContent = `错误：${error.message}。详情见控制台。`;
    }
}

async function restoreBackup(backupData, targetCharacterIndex = null) {
    logDebug('[恢复流程] 开始通过导入API恢复备份:', {
        chatKey: backupData.chatKey,
        timestamp: backupData.timestamp,
        targetIndex: targetCharacterIndex,
    });
    logDebug('[恢复流程] 原始备份数据:', JSON.parse(JSON.stringify(backupData)));

    if (!backupData.chatFileContent || typeof backupData.chatFileContent !== 'string' || backupData.chatFileContent.trim().length === 0) {
        toastr.error('备份数据无效：缺少或空的 chatFileContent。', '恢复失败');
        return false;
    }

    const originalEntityName = backupData.entityName || '未知实体';
    const originalChatName = backupData.chatName || '未知聊天';

    const isGroupBackup = backupData.chatKey.startsWith('group_');
    let originalEntityId = null;

    if (isGroupBackup) {
        // 如果是手动恢复到角色，则不允许恢复群组备份
        if (targetCharacterIndex !== null) {
            toastr.error('无法将群组聊天备份恢复到单个角色。', '恢复失败');
            return false;
        }
        const match = backupData.chatKey.match(/^group_([^_]+)_/);
        originalEntityId = match ? match[1] : null;
    } else {
        const match = backupData.chatKey.match(/^char_(\d+)_/);
        originalEntityId = match ? match[1] : null;
    }

    if (!originalEntityId && targetCharacterIndex === null) {
        toastr.error('无法从备份数据中解析原始实体ID。', '恢复失败');
        return false;
    }

    let success = false;

    try {
        if (isGroupBackup) { // 恢复到原始群组 (逻辑不变)
            const targetGroupId = originalEntityId;
            const targetGroup = getContext().groups?.find(g => g.id === targetGroupId);

            if (!targetGroup) {
                toastr.error(`原始群组 (ID: ${targetGroupId}) 不存在，无法恢复。`, '恢复失败');
                return false;
            }

            logDebug(`[恢复流程] 准备将备份导入到原始群组: ${targetGroup.name} (ID: ${targetGroupId})`);

            // 对于群组恢复，直接使用原始字符串创建File对象，无需解析
            const restoredInternalFilename = `${originalChatName}.jsonl`;
            const chatFileObject = new File([backupData.chatFileContent], restoredInternalFilename, { type: "application/json-lines" });
            logDebug(`[恢复流程] 已创建 File 对象: ${chatFileObject.name}, 大小: ${chatFileObject.size} bytes`);

            const formData = new FormData();
            formData.append('file', chatFileObject);
            formData.append('file_type', 'jsonl');
            formData.append('group_id', targetGroupId);

            const response = await fetch('/api/chats/group/import', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: formData,
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: '未知API错误' }));
                throw new Error(`群组聊天导入API失败: ${response.status} - ${errorData.error}`);
            }

            const importResult = await response.json();
            if (!importResult.res) {
                throw new Error('群组聊天导入API未返回有效的聊天ID。');
            }

            const newGroupChatId = importResult.res;
            logDebug(`[恢复流程] 群组聊天导入成功，新聊天ID: ${newGroupChatId}。`);

            logDebug(`[恢复流程] 正在加载新导入的群组聊天: ${newGroupChatId} 到群组 ${targetGroupId}...`);
            await select_group_chats(targetGroupId, newGroupChatId);

            // --- 等待群组和聊天上下文确认加载 ---
            await waitForContextChange({ groupId: targetGroupId, chatId: newGroupChatId });
            logDebug(`[恢复流程] 群组和聊天上下文已确认加载。`);

            toastr.success(`备份已作为新聊天 "${newGroupChatId}" 导入到群组 "${targetGroup.name}"！`);
            success = true;

        } else { // 恢复到角色 (原始或指定)
            // 优先使用传入的 targetCharacterIndex，否则回退到从备份数据中解析
            const finalTargetIndex = targetCharacterIndex !== null
                ? targetCharacterIndex
                : parseInt(originalEntityId, 10);

            // 直接从上下文中获取已加载的角色列表，避免调用 getCharacters() 引入副作用
            const characters = getContext().characters;

            if (isNaN(finalTargetIndex) || finalTargetIndex < 0 || finalTargetIndex >= characters.length) {
                toastr.error(`目标角色索引 (${finalTargetIndex}) 无效或超出范围。`, '恢复失败');
                return false;
            }

            const targetCharacter = characters[finalTargetIndex];
            if (!targetCharacter) {
                toastr.error(`无法找到目标角色 (索引: ${finalTargetIndex})。`, '恢复失败');
                return false;
            }

            logDebug(`[恢复流程] 准备将备份内容作为新聊天保存到角色: ${targetCharacter.name} (索引: ${finalTargetIndex})`);

            // 只有角色聊天恢复需要解析后的数组
            let parsedContent;
            try {
                toastr.info('正在解析聊天数据...', '恢复流程', {timeOut: 2000});
                parsedContent = await parseJsonlInWorker(backupData.chatFileContent, { parseFull: true });
            } catch (error) {
                console.error('[恢复流程] JSONL 解析失败:', error);
                throw new Error(`JSONL 解析失败: ${error.message}`);
            }

            if (!parsedContent || !Array.isArray(parsedContent) || parsedContent.length < 1) {
                throw new Error('备份数据格式错误：JSONL 解析结果无效。');
            }

            const newChatIdForRole = `${originalChatName}.jsonl`.replace('.jsonl', '');
            let chatToSaveForRole = parsedContent; // API需要完整的数组 [meta, ...messages]

            // --- 同步元数据中的角色和用户名 ---
            // 这是解决 400 Bad Request 错误的关键。
            // 服务器会校验顶层的 ch_name 和 chat[0].character_name 是否一致。
            if (chatToSaveForRole && Array.isArray(chatToSaveForRole) && chatToSaveForRole.length > 0 && typeof chatToSaveForRole[0] === 'object') {
                const metadata = chatToSaveForRole[0];
                const currentUserName = getContext().name1; // 获取当前用户名

                logDebug(`[恢复流程] 正在修正元数据: old_char="${metadata.character_name}", new_char="${targetCharacter.name}"; old_user="${metadata.user_name}", new_user="${currentUserName}"`);

                metadata.character_name = targetCharacter.name;
                metadata.user_name = currentUserName;
            } else {
                // 如果备份数据格式不正确，抛出错误以中断恢复流程
                throw new Error('备份数据格式错误：无法找到有效的元数据对象。');
            }

            // 1. 保存新的聊天文件
            const saveResponse = await fetch('/api/chats/save', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    ch_name: targetCharacter.name,
                    file_name: newChatIdForRole,
                    chat: chatToSaveForRole,
                    avatar_url: targetCharacter.avatar,
                    force: true // 不进行完整性检查，避免恢复失败
                }),
            });

            if (!saveResponse.ok) {
                const errorText = await saveResponse.text();
                throw new Error(`保存角色聊天API失败: ${saveResponse.status} - ${errorText}`);
            }

            logDebug(`[恢复流程] 角色聊天内容已通过 /api/chats/save 保存为: ${newChatIdForRole}.jsonl`);

            // --- 等待聊天文件被服务器识别 ---
            await waitForChatFile(finalTargetIndex, newChatIdForRole);

            // 2. 检查并切换角色 (如果需要)
            const currentContextBeforeOpen = getContext();
            if (String(currentContextBeforeOpen.characterId) !== String(finalTargetIndex)) {
                logDebug(`[恢复流程] 当前角色 (ID: ${currentContextBeforeOpen.characterId}) 与目标 (索引: ${finalTargetIndex}) 不同，执行切换...`);
                await selectCharacterById(finalTargetIndex);

                // --- 等待角色上下文更新 ---
                await waitForContextChange({ characterId: finalTargetIndex });
                logDebug(`[恢复流程] 已切换到目标角色 (索引: ${finalTargetIndex})`);
            } else {
                logDebug(`[恢复流程] 当前已在目标角色 (索引: ${finalTargetIndex}) 上下文中，无需切换。`);
            }

            // 3. 打开新保存的聊天文件
            logDebug(`[恢复流程] 正在打开新聊天: ${newChatIdForRole}`);
            await openCharacterChat(newChatIdForRole);

            // --- 等待聊天被加载到上下文中 ---
            await waitForContextChange({ chatId: newChatIdForRole });
            logDebug(`[恢复流程] 聊天 "${newChatIdForRole}" 已确认加载。`);

            toastr.success(`备份已作为新聊天 "${newChatIdForRole}" 恢复到角色 "${targetCharacter.name}"！`);
            success = true;
        }

        if (success) {
            logDebug('[恢复流程] 恢复流程成功完成。');
            if (typeof updateBackupsList === 'function') {
                 await updateBackupsList();
            }
        }
        return success;

    } catch (error) {
        console.error('[恢复流程] 恢复备份时发生严重错误:', error);
        toastr.error(`恢复备份失败：${error.message}`, '恢复失败', { timeOut: 7000 });
        return false;
    }
}

// --- 更新备份列表UI ---
async function updateBackupsList() {
    logDebug('[聊天自动备份] 开始更新备份列表UI');
    const backupsContainer = $('#chat_backup_list');
    if (!backupsContainer.length) {
        console.warn('[聊天自动备份] 找不到备份列表容器元素 #chat_backup_list');
        return;
    }

    backupsContainer.html('<div class="backup_empty_notice">正在加载备份...</div>');

    try {
        const allMetas = await getAllBackupsMeta();
        backupsContainer.empty(); // 清空

        if (allMetas.length === 0) {
            backupsContainer.append('<div class="backup_empty_notice">暂无保存的备份</div>');
            return;
        }

        // 按时间降序排序
        allMetas.sort((a, b) => b.timestamp - a.timestamp);
        logDebug(`渲染 ${allMetas.length} 个备份`);

        allMetas.forEach(meta => {
            const date = new Date(meta.timestamp);
            const formattedDate = date.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' });

            // 添加调试日志
            logDebug(`原始 meta.lastMessagePreview: ${meta.lastMessagePreview}`);

            // 1. 先生成完整的、未截断的预览文本
            const fullPreviewText = filterSpecialTags(meta.lastMessagePreview || '');

            // 2. 根据完整文本生成截断后的显示文本
            const maxPreviewLength = 100;
            const previewText = fullPreviewText.length > maxPreviewLength
                ? fullPreviewText.slice(0, maxPreviewLength) + '...'
                : fullPreviewText;

            // 检查是否为群组备份，如果是，则禁用"手动恢复"按钮
            const isGroupBackup = meta.chatKey.startsWith('group_');
            const manualRestoreButton = isGroupBackup
                ? `<button class="menu_button" disabled title="群组备份不支持恢复到角色">手动恢复</button>`
                : `<button class="menu_button backup_manual_restore" title="将此备份恢复到指定角色" data-timestamp="${meta.timestamp}" data-key="${meta.chatKey}">手动</button>`;


            const backupItem = $(`
                <div class="backup_item">
                    <div class="backup_info">
                        <div class="backup_header">
                            <span class="backup_entity" title="${meta.entityName}">${meta.entityName || '未知实体'}</span>
                            <span class="backup_chat" title="${meta.chatName}">${meta.chatName || '未知聊天'}</span>
                        </div>
                        <div class="backup_details">
                            <span class="backup_mesid">消息数: ${meta.lastMessageId + 1}</span>
                            <span class="backup_date">${formattedDate}</span>
                        </div>
                        <div class="backup_preview" title="${fullPreviewText}">${previewText}</div>
                    </div>
                    <div class="backup_actions">
                        <button class="menu_button backup_preview_btn" title="预览此备份的最后两条消息" data-timestamp="${meta.timestamp}" data-key="${meta.chatKey}">预览</button>
                        <button class="menu_button backup_restore" title="恢复此备份到新聊天" data-timestamp="${meta.timestamp}" data-key="${meta.chatKey}">恢复</button>
                        <button class="menu_button danger_button backup_delete" title="删除此备份" data-timestamp="${meta.timestamp}" data-key="${meta.chatKey}">删除</button>
                        ${manualRestoreButton}
                    </div>
                </div>
            `);
            backupsContainer.append(backupItem);
        });

        logDebug('[聊天自动备份] 备份列表渲染完成');
    } catch (error) {
        console.error('[聊天自动备份] 更新备份列表失败:', error);
        backupsContainer.html(`<div class="backup_empty_notice">加载备份列表失败: ${error.message}</div>`);
    }
}

// --- 初始化与事件绑定 ---
jQuery(async () => {
    logDebug('[聊天自动备份] 插件开始加载...');

    // 初始化设置
    const settings = initSettings();

    // 防止重复初始化的标志位
    let isInitialized = false;

    // --- 将各个初始化步骤拆分成独立函数 ---
    
    // 初始化数据库
    const initializeDatabase = async () => {
        logDebug('[聊天自动备份] 初始化数据库');
        try {
            await initDatabase();
            // 在下方添加
            if (navigator.storage?.persist) {
                try {
                    const persisted = await navigator.storage.persist();
                    logDebug('[BackupDB] storage.persist():', persisted ? 'granted' : 'not granted');
                } catch (e) {
                    console.warn('[BackupDB] storage.persist() failed:', e);
                }
            }
            return true;
        } catch (error) {
            console.error('[聊天自动备份] 数据库初始化失败:', error);
            return false;
        }
    };

    // 初始化 JSONL 解析器 Web Worker
    const initializeJsonlParserWorker = () => {
        logDebug('[聊天自动备份] 初始化 JSONL 解析器 Web Worker');
        try {
            // 验证代码字符串的语法
            logDebug('[聊天自动备份] Web Worker 代码长度:', jsonlParserLogicString.length);

            const blob = new Blob([jsonlParserLogicString], { type: 'application/javascript' });
            const workerUrl = URL.createObjectURL(blob);
            logDebug('[聊天自动备份] Worker URL 创建成功:', workerUrl);

            jsonlParserWorker = new Worker(workerUrl);
            logDebug('[聊天自动备份] JSONL 解析器 Web Worker 已创建');

            // 设置 Worker 消息处理器 (主线程)
            jsonlParserWorker.onmessage = function(e) {
                const { id, result, error } = e.data;
                const promise = parserWorkerPromises[id];

                if (promise) {
                    if (error) {
                        console.error(`[JSONL Parser] Worker 返回错误 (ID: ${id}):`, error);
                        promise.reject(new Error(error));
                    } else {
                        promise.resolve(result);
                    }
                    delete parserWorkerPromises[id];
                } else {
                    console.warn(`[JSONL Parser] 收到未知或已处理的 Worker 消息 (ID: ${id})`);
                }
            };

            // 设置 Worker 错误处理器 (主线程)
            jsonlParserWorker.onerror = function(error) {
                console.error('[聊天自动备份] JSONL 解析器 Web Worker 发生错误:', error);
                console.error('[聊天自动备份] 错误详情:', {
                    message: error.message,
                    filename: error.filename,
                    lineno: error.lineno,
                    colno: error.colno,
                    error: error.error
                });
                // 拒绝所有待处理的 Promise
                Object.keys(parserWorkerPromises).forEach(id => {
                    parserWorkerPromises[id].reject(new Error('JSONL parser worker encountered an unrecoverable error.'));
                    delete parserWorkerPromises[id];
                });
                toastr.error('JSONL 解析器 Worker 发生错误: ' + error.message, '聊天自动备份');
            };

            return true;
        } catch (workerError) {
            console.error('[聊天自动备份] 创建 JSONL 解析器 Web Worker 失败:', workerError);
            jsonlParserWorker = null;
            return false;
        }
    };

    // 加载插件UI
    const initializePluginUI = async () => {
        logDebug('[聊天自动备份] 初始化插件UI');
        try {
            // 加载模板
            const settingsHtml = await renderExtensionTemplateAsync(
                `third-party/${PLUGIN_NAME}`,
                'settings'
            );
            $('#extensions_settings').append(settingsHtml);
            logDebug('[聊天自动备份] 已添加设置界面');

            // 设置控制项
            const $settingsBlock = $('<div class="chat_backup_control_item"></div>');
            $settingsBlock.html(`
                <div style="margin-bottom: 8px;">
                    <label style="display: inline-block; min-width: 120px;">最大角色/群组数:</label>
                    <input type="text" id="chat_backup_max_entity" value="${settings.maxEntityCount}" 
                        title="保留多少个不同角色/群组的备份" 
                        style="width: 80px;" inputmode="numeric" />
                </div>
                <div>
                    <label style="display: inline-block; min-width: 120px;">每组最大备份数:</label>
                    <input type="text" id="chat_backup_max_per_entity" value="${settings.maxBackupsPerEntity}" 
                        title="每个角色/群组保留多少个备份" 
                        style="width: 80px;" inputmode="numeric" />
                </div>
            `);
            $('.chat_backup_controls').prepend($settingsBlock);
                       
            // 设置使用说明按钮
            setupHelpButton();
            
            return true;
        } catch (error) {
            console.error('[聊天自动备份] 初始化插件UI失败:', error);
            return false;
        }
    };
    
    // 设置UI控件事件监听
    const setupUIEvents = () => {
        logDebug('[聊天自动备份] 设置UI事件监听');
        
        // 添加最大备份数设置监听
        $(document).on('input', '#chat_backup_max_total', function() {
            const total = parseInt($(this).val(), 10);
            if (!isNaN(total) && total >= 1 && total <= 50) {
                settings.maxTotalBackups = total;
                logDebug(`系统最大备份数已更新为: ${total}`);
                saveSettingsDebounced();
            } else {
                logDebug(`无效的系统最大备份数输入: ${$(this).val()}`);
                $(this).val(settings.maxTotalBackups);
            }
        });

        // --- 使用事件委托绑定UI事件 ---
        $(document).on('click', '#chat_backup_manual_backup', performManualBackup);

        // 防抖延迟设置
        $(document).on('change', '#chat_backup_debounce_delay', function() {
            const value = $(this).val().trim();
            const delay = parseInt(value, 10);
            if (!isNaN(delay) && delay >= 300 && delay <= 30000) {
                settings.backupDebounceDelay = delay;
                logDebug(`防抖延迟已更新为: ${delay}ms`);
                saveSettingsDebounced();
            } else {
                logDebug(`无效的防抖延迟输入: ${value}`);
                $(this).val(settings.backupDebounceDelay);
            }
        });

        // 恢复按钮
        $(document).on('click', '.backup_restore', async function() {
            const button = $(this);
            const timestamp = parseInt(button.data('timestamp'));
            const chatKey = button.data('key');
            logDebug(`点击恢复按钮, timestamp: ${timestamp}, chatKey: ${chatKey}`);

            button.prop('disabled', true).text('恢复中...');

            try {
                // 使用单个高效的函数一次性获取完整备份数据
                const backup = await getFullBackup(chatKey, timestamp);

                if (!backup) {
                    console.error('[聊天自动备份] 找不到指定的备份:', { timestamp, chatKey });
                    toastr.error('找不到指定的备份');
                    button.prop('disabled', false).text('恢复');
                    return;
                }

                // 如果用户尚未确认，并且点击了"取消"，则直接返回
                if (!hasUserConfirmedRestore() && !confirm(`确定要恢复 " ${backup.entityName} - ${backup.chatName} " 的备份吗？\n\n插件将自动选中对应的角色/群组，并创建一个【新的聊天】来恢复备份内容。\n\n不论原有聊天是否存在，该备份恢复都不会影响或覆盖原聊天记录，该备份也不会被删除，请勿担心。\n\n本次过后，该弹窗后续将不会出现`)) {
                    logDebug('[聊天自动备份] 用户取消恢复操作');
                    button.prop('disabled', false).text('恢复');
                    return;
                }

                // 如果代码执行到这里，意味着用户要么已经确认过，要么刚刚点击了"确定"
                setUserConfirmedRestore(true); // 无论之前状态如何，现在都设为true
                toastr.info(`正在恢复"${backup.entityName} - ${backup.chatName}"的备份...`, '聊天自动备份');
                closeExtensionsAndBackupUI();
                await restoreBackup(backup);

            } catch (error) {
                console.error('[聊天自动备份] 恢复过程中出错:', error);
                toastr.error(`恢复过程中出错: ${error.message}`);
                button.prop('disabled', false).text('恢复');
            }
        });

        // 删除按钮
        $(document).on('click', '.backup_delete', async function() {
            const button = $(this);
            const timestamp = parseInt(button.data('timestamp'));
            const chatKey = button.data('key');
            logDebug(`点击删除按钮, timestamp: ${timestamp}, chatKey: ${chatKey}`);

            const backupItem = button.closest('.backup_item');
            const entityName = backupItem.find('.backup_entity').text();
            const chatName = backupItem.find('.backup_chat').text();
            const date = backupItem.find('.backup_date').text();

            if (confirm(`确定要永久删除这个备份吗？\n\n实体: ${entityName}\n聊天: ${chatName}\n时间: ${date}\n\n此操作无法撤销！`)) {
                button.prop('disabled', true).text('删除中...');
                try {
                    await deleteBackup(chatKey, timestamp);
                    toastr.success('备份已删除');
                    backupItem.fadeOut(300, function() { $(this).remove(); }); // 平滑移除条目
                    // 可选：如果列表为空，显示提示
                    if ($('#chat_backup_list .backup_item').length <= 1) { // <=1 因为当前这个还在DOM里，将要移除
                        updateBackupsList(); // 重新加载以显示"无备份"提示
                    }
                } catch (error) {
                    console.error('[聊天自动备份] 删除备份失败:', error);
                    toastr.error(`删除备份失败: ${error.message}`);
                    button.prop('disabled', false).text('删除');
                }
            }
        });

        // 手动恢复按钮
        $(document).on('click', '.backup_manual_restore', async function() {
            const button = $(this);
            const timestamp = parseInt(button.data('timestamp'));
            const chatKey = button.data('key');
            logDebug(`点击手动恢复按钮, timestamp: ${timestamp}, chatKey: ${chatKey}`);

            button.prop('disabled', true).text('加载中...');

            try {
                const backup = await getFullBackup(chatKey, timestamp);
                if (!backup) {
                    toastr.error('找不到指定的备份');
                    return;
                }

                // 显示角色选择弹窗
                await showManualRestorePopup(backup);

            } catch (error) {
                console.error('[聊天自动备份] 打开手动恢复弹窗时出错:', error);
                toastr.error(`操作失败: ${error.message}`);
            } finally {
                button.prop('disabled', false).text('手动恢复');
            }
        });

        // 预览按钮
        $(document).on('click', '.backup_preview_btn', async function() {
            const button = $(this);
            const timestamp = parseInt(button.data('timestamp'));
            const chatKey = button.data('key');
            logDebug(`点击预览按钮, timestamp: ${timestamp}, chatKey: ${chatKey}`);
            button.prop('disabled', true).text('加载中...');

            try {
                // 1. 只获取元数据 (极快)
                const meta = await getBackupMeta(chatKey, timestamp);
                if (!meta) {
                    throw new Error('无法找到备份元数据');
                }

                // 2. 直接使用元数据中缓存的最后两条消息 (无I/O, 无需Worker)
                const lastMessages = meta.lastTwoMessages || [];

                if (lastMessages && lastMessages.length > 0) {
                    // 创建样式
                    const style = document.createElement('style');
                    style.textContent = `
                        .preview_container {
                            display: flex;
                            flex-direction: column;
                            padding: 0;
                            max-height: 80vh;
                            width: 100%;
                            background-color: #f9f9f9;
                            border-radius: 12px;
                            overflow: hidden;
                        }

                        .preview_header {
                            background-color: #e9ecef;
                            padding: 15px 20px;
                            border-bottom: 1px solid #dee2e6;
                            flex-shrink: 0;
                        }

                        .preview_header h3 {
                            margin: 0 0 10px 0;
                            color: #495057;
                            font-size: 1.2em;
                        }

                        .preview_metadata {
                            display: flex;
                            gap: 20px;
                            flex-wrap: wrap;
                            font-size: 0.9em;
                            color: #6c757d;
                        }

                        .meta_label {
                            font-weight: bold;
                            margin-right: 5px;
                        }

                        .messages_container {
                            flex: 1;
                            padding: 20px;
                            overflow-y: auto;
                            display: flex;
                            flex-direction: column;
                            gap: 15px;
                            background-color: #ffffff;
                        }

                        .message_box {
                            padding: 15px;
                            border-radius: 18px;
                            max-width: 75%;
                            color: white;
                            position: relative;
                            box-shadow: 0 1px 2px rgba(0,0,0,0.2);
                            word-break: break-word;
                            text-align: left !important;
                        }

                        .message_box * {
                            text-align: left !important;
                        }

                        .message_box p {
                            text-align: left !important;
                            margin: 0 0 10px 0;
                        }

                        .message_box strong,
                        .message_box em,
                        .message_box span,
                        .message_box div {
                            text-align: left !important;
                        }

                        .user_message {
                            background-color: #8A2BE2;
                            align-self: flex-end;
                            border-bottom-right-radius: 4px;
                            margin-left: 25%;
                        }

                        .assistant_message {
                            background-color: #FFA500;
                            align-self: flex-start;
                            border-bottom-left-radius: 4px;
                            margin-right: 25%;
                        }

                        .user_message::after {
                            content: '';
                            position: absolute;
                            bottom: 0;
                            right: -10px;
                            width: 20px;
                            height: 20px;
                            background-color: #8A2BE2;
                            border-bottom-left-radius: 16px;
                            z-index: -1;
                        }

                        .assistant_message::after {
                            content: '';
                            position: absolute;
                            bottom: 0;
                            left: -10px;
                            width: 20px;
                            height: 20px;
                            background-color: #FFA500;
                            border-bottom-right-radius: 16px;
                            z-index: -1;
                        }
                    `;
                    document.head.appendChild(style);

                    // 创建预览容器
                    const previewContainer = document.createElement('div');
                    previewContainer.className = 'preview_container';

                    // 添加标题区域
                    const headerSection = document.createElement('div');
                    headerSection.className = 'preview_header';

                    const formattedTimestamp = new Date(meta.timestamp).toLocaleString();
                    const entityName = meta.entityName || '未知角色/群组';
                    const messagesCount = meta.lastMessageId + 1;

                    headerSection.innerHTML = `
                        <h3>聊天记录预览</h3>
                        <div class="preview_metadata">
                            <div><span class="meta_label">来自:</span> ${entityName}</div>
                            <div><span class="meta_label">消息数:</span> ${messagesCount}</div>
                            <div><span class="meta_label">备份时间:</span> ${formattedTimestamp}</div>
                        </div>
                    `;

                    previewContainer.appendChild(headerSection);

                    // 创建消息容器
                    const messagesContainer = document.createElement('div');
                    messagesContainer.className = 'messages_container';
                    previewContainer.appendChild(messagesContainer);

                    // 将消息添加到消息容器中
                    lastMessages.forEach((msg, index) => {
                        const messageDiv = document.createElement('div');
                        messageDiv.className = `message_box ${msg.is_user ? 'user_message' : 'assistant_message'}`;
                        messageDiv.innerHTML = processMessage(msg.mes || msg);
                        messagesContainer.appendChild(messageDiv);
                    });

                    // 显示预览弹窗
                    const popup = new Popup(previewContainer, POPUP_TYPE.DISPLAY, '', {
                        wide: true,
                        large: true,
                        allowVerticalScrolling: false,
                        transparent: true
                    });
                    await popup.show();
                } else {
                    alert('没有可供预览的消息或备份格式不正确');
                }
            } catch (error) {
                console.error('预览备份时出错:', error);
                alert('预览备份时出错: ' + error.message);
            } finally {
                button.prop('disabled', false).text('预览');
            }
        });

        // 调试开关
        $(document).on('change', '#chat_backup_debug_toggle', function() {
            settings.debug = $(this).prop('checked');
            logDebug('[聊天自动备份] 调试模式已' + (settings.debug ? '启用' : '禁用'));
            saveSettingsDebounced();
        });
        
        // 监听扩展页面打开事件，刷新列表
        $(document).on('click', '#extensionsMenuButton', () => {
            if ($('#chat_auto_backup_settings').is(':visible')) {
                logDebug('[聊天自动备份] 扩展菜单按钮点击，且本插件设置可见，刷新备份列表');
                setTimeout(updateBackupsList, 200); // 稍作延迟确保面板内容已加载
            }
        });

        // 抽屉打开时也刷新
        $(document).on('click', '#chat_auto_backup_settings .inline-drawer-toggle', function() {
            const drawer = $(this).closest('.inline-drawer');
            // 检查抽屉是否即将打开 (基于当前是否有 open class)
            if (!drawer.hasClass('open')) {
                logDebug('[聊天自动备份] 插件设置抽屉打开，刷新备份列表');
                setTimeout(updateBackupsList, 50); // 几乎立即刷新
            }
        });

        // 添加最大角色/群组数设置监听
        $(document).on('change', '#chat_backup_max_entity', function() {
            const value = $(this).val().trim();
            const count = parseInt(value, 10);
            if (!isNaN(count) && count >= 1 && count <= 10) {
                settings.maxEntityCount = count;
                logDebug(`最大角色/群组数已更新为: ${count}`);
                saveSettingsDebounced();
            } else {
                logDebug(`无效的最大角色/群组数输入: ${value}`);
                $(this).val(settings.maxEntityCount);
            }
        });
        
        // 添加每组最大备份数设置监听
        $(document).on('change', '#chat_backup_max_per_entity', function() {
            const value = $(this).val().trim();
            const count = parseInt(value, 10);
            if (!isNaN(count) && count >= 1 && count <= 10) {
                settings.maxBackupsPerEntity = count;
                logDebug(`每组最大备份数已更新为: ${count}`);
                saveSettingsDebounced();
            } else {
                logDebug(`无效的每组最大备份数输入: ${value}`);
                $(this).val(settings.maxBackupsPerEntity);
            }
        });
    };
    
    // 初始化UI状态
    const initializeUIState = async () => {
        logDebug('[聊天自动备份] 初始化UI状态');
        $('#chat_backup_debug_toggle').prop('checked', settings.debug);
        $('#chat_backup_debounce_delay').val(settings.backupDebounceDelay);
        $('#chat_backup_max_entity').val(settings.maxEntityCount);
        $('#chat_backup_max_per_entity').val(settings.maxBackupsPerEntity);
        
        // 检查用户是否已确认过恢复操作
        const confirmed = hasUserConfirmedRestore();
        logDebug(`[聊天自动备份] 加载用户恢复确认状态: ${confirmed}`);
        
        await updateBackupsList();
    };
    
    // 设置备份事件监听
    const setupBackupEvents = () => {
        logDebug('[聊天自动备份] 设置备份事件监听 (优化版)');
        
        // 监听消息发送事件来设置标志
        if (event_types.MESSAGE_SENT) {
            eventSource.on(event_types.MESSAGE_SENT, () => {
                logDebug(`Event: MESSAGE_SENT`);
                // 设置标志，表示刚刚发送了消息
                messageSentRecently = true;
                
                // 清除任何现有的重置计时器
                if (messageSentResetTimer) {
                    clearTimeout(messageSentResetTimer);
                }
                
                // 1秒后自动重置标志，以防 GENERATION_STARTED 未触发
                messageSentResetTimer = setTimeout(() => {
                    messageSentRecently = false;
                    messageSentResetTimer = null;
                    logDebug(`自动重置 messageSentRecently 标志`);
                }, 1000);
            });
        }

        // 只有生成结束事件使用强制保存
        if (event_types.GENERATION_ENDED) {
            eventSource.on(event_types.GENERATION_ENDED, () => {
                logDebug(`Event: GENERATION_ENDED`);
                // 重置消息发送标志
                messageSentRecently = false;
                if (messageSentResetTimer) {
                    clearTimeout(messageSentResetTimer);
                    messageSentResetTimer = null;
                }
                
                performBackupConditional(BACKUP_TYPE.STANDARD, true).catch(e => 
                    console.error("GENERATION_ENDED backup error", e));
            });
        }

        // 修改用户发送消息后的生成启动事件
        if (event_types.GENERATION_STARTED) {
            eventSource.on(event_types.GENERATION_STARTED, () => {
                logDebug(`Event: GENERATION_STARTED (messageSentRecently: ${messageSentRecently})`);
                
                // 只有当最近发送过消息时才执行备份
                if (messageSentRecently) {
                    performBackupConditional(BACKUP_TYPE.STANDARD, false).catch(e => 
                        console.error("GENERATION_STARTED backup error", e));
                    
                    // 处理完毕后重置标志
                    messageSentRecently = false;
                    if (messageSentResetTimer) {
                        clearTimeout(messageSentResetTimer);
                        messageSentResetTimer = null;
                    }
                } else {
                    logDebug(`跳过 GENERATION_STARTED 事件的备份，因为不是由消息发送触发的`);
                }
            });
        }
        
        // CHARACTER_FIRST_MESSAGE_SELECTED改为防抖备份
        if (event_types.CHARACTER_FIRST_MESSAGE_SELECTED) {
            eventSource.on(event_types.CHARACTER_FIRST_MESSAGE_SELECTED, () => {
                logDebug(`Event: CHARACTER_FIRST_MESSAGE_SELECTED`);
                scheduleIdle(() => performBackupDebounced(BACKUP_TYPE.STANDARD));
            });
        }

        // 消息切换仍然是防抖备份SWIPE类型
        if (event_types.MESSAGE_SWIPED) {
            eventSource.on(event_types.MESSAGE_SWIPED, () => {
                logDebug(`Event: MESSAGE_SWIPED`);
                scheduleIdle(() => performBackupDebounced(BACKUP_TYPE.SWIPE));
            });
        }

        // 消息更新仍然是防抖备份
        if (event_types.MESSAGE_UPDATED) {
            eventSource.on(event_types.MESSAGE_UPDATED, () => {
                logDebug(`Event: MESSAGE_UPDATED`);
                scheduleIdle(() => performBackupDebounced(BACKUP_TYPE.STANDARD));
            });
        }

        // 其他防抖事件
        const otherDebouncedEvents = [
            event_types.IMAGE_SWIPED,
            event_types.MESSAGE_FILE_EMBEDDED,
            event_types.MESSAGE_REASONING_EDITED,
            event_types.MESSAGE_REASONING_DELETED,
            event_types.FILE_ATTACHMENT_DELETED,
            event_types.GROUP_UPDATED
        ].filter(Boolean);

        otherDebouncedEvents.forEach(eventType => {
            if (eventType) {
                eventSource.on(eventType, () => {
                    logDebug(`Event (Other Debounced): ${eventType}`);
                    scheduleIdle(() => performBackupDebounced(BACKUP_TYPE.STANDARD));
                });
            }
        });
        
        // 添加删除消息事件监听 - 使用强制保存确保最新状态
        if (event_types.MESSAGE_DELETED) {
            eventSource.on(event_types.MESSAGE_DELETED, () => {
                logDebug(`Event: MESSAGE_DELETED`);
                // 使用强制保存以确保获取最新状态
                performBackupConditional(BACKUP_TYPE.STANDARD, true).catch(e => 
                    console.error("MESSAGE_DELETED backup error", e));
            });
        }
        
        // 添加批量删除消息事件监听
        if (event_types.MESSAGES_DELETED) {
            eventSource.on(event_types.MESSAGES_DELETED, () => {
                logDebug(`Event: MESSAGES_DELETED`);
                // 使用强制保存以确保获取最新状态
                performBackupConditional(BACKUP_TYPE.STANDARD, true).catch(e => 
                    console.error("MESSAGES_DELETED backup error", e));
            });
        }
        
        logDebug('优化后的备份事件监听器设置完成。');
    };
    
    // 执行初始备份检查
    const performInitialBackupCheck = async () => {
        logDebug('[聊天自动备份] 执行初始备份检查');
        try {
            const context = getContext();
            if (context.chat && context.chat.length > 0 && !isBackupInProgress) {
                logDebug('[聊天自动备份] 发现现有聊天记录，执行初始备份');
                await performBackupConditional(BACKUP_TYPE.STANDARD, true); // 初始备份应使用强制保存
            } else {
                logDebug('[聊天自动备份] 当前没有聊天记录或备份进行中，跳过初始备份');
            }
        } catch (error) {
            console.error('[聊天自动备份] 初始备份执行失败:', error);
        }
    };

    // --- 主初始化函数 ---
    const initializeExtension = async () => {
        if (isInitialized) {
            logDebug('[聊天自动备份] 初始化已运行。跳过。');
            return;
        }
        isInitialized = true;
        logDebug('[聊天自动备份] 由 app_ready 事件触发，运行初始化任务。');
        
        try {
            // 顺序执行初始化任务
            if (!await initializeDatabase()) {
                console.warn('[聊天自动备份] 数据库初始化失败，但将尝试继续');
            }

            initializeJsonlParserWorker();

            if (!await initializePluginUI()) {
                console.warn('[聊天自动备份] 插件UI初始化失败，但将尝试继续');
            }
            
            setupUIEvents();
            setupBackupEvents();
            setupKeyboardShortcuts(); // 添加这一行来设置快捷键
            
            await initializeUIState();
            
            // 移除旧的表格抽屉查找和设置代码，替换为新的轮询函数调用
            logDebug('[聊天自动备份] 初始化表格抽屉监听系统...');
            setupTableDrawerObserver();
            
            // 延迟一小段时间后执行初始备份检查，确保系统已经稳定
            setTimeout(performInitialBackupCheck, 1000);
            
            logDebug('[聊天自动备份] 插件加载完成');
        } catch (error) {
            console.error('[聊天自动备份] 插件加载过程中发生严重错误:', error);
            $('#extensions_settings').append(
                '<div class="error">聊天自动备份插件加载失败，请检查控制台。</div>'
            );
        }
    };

    // --- 监听SillyTavern的app_ready事件 ---
    eventSource.on('app_ready', initializeExtension);
    
    // 如果事件已经错过，则直接初始化
    if (window.SillyTavern?.appReady) {
        logDebug('[聊天自动备份] app_ready已发生，直接初始化');
        initializeExtension();
    } else {
        logDebug('[聊天自动备份] 等待app_ready事件触发初始化');
        // 设置安全兜底，确保插件最终会初始化
        setTimeout(() => {
            if (!isInitialized) {
                console.warn('[聊天自动备份] app_ready事件未触发，使用兜底机制初始化');
                initializeExtension();
            }
        }, 3000); // 3秒后如果仍未初始化，则强制初始化
    }
});

function processMessage(messageText) {
    const startTime = performance.now();
    try {
        // 更严格的类型检查
        if (messageText === null || messageText === undefined) {
            return '(空消息)';
        }
        
        // 确保是字符串类型
        if (typeof messageText !== 'string') {
            if (typeof messageText === 'object' && messageText !== null) {
                // 尝试从对象中提取消息内容
                messageText = messageText.mes || String(messageText);
            } else {
                messageText = String(messageText);
            }
        }
        
        // 使用抽取的过滤函数
        let processed = filterSpecialTags(messageText);
        
        // 过滤代码块
        processed = processed
            .replace(/```[\s\S]*?```/g, '')
            .replace(/`[\s\S]*?`/g, '');
        
        // 处理连续空行和空白问题
        processed = processed
            .replace(/\n\s*\n\s*\n+/g, '\n\n')
            .trim()
            .replace(/ {2,}/g, ' ');
        
        // 简单的Markdown处理
        processed = processed
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            .replace(/\n\n+/g, '</p><p class="message-paragraph">')
            .replace(/\n/g, '<br>');
        
        // 确保内容被段落包围
        if (!processed.startsWith('<p')) {
            processed = `<p class="message-paragraph">${processed}`;
        }
        if (!processed.endsWith('</p>')) {
            processed = `${processed}</p>`;
        }
        
        return processed;
    } catch (error) {
        console.error('[聊天自动备份] 消息处理失败:', error);
        return '(消息处理失败)';
    } finally {
        const endTime = performance.now();
        if (endTime - startTime > 100) { // 如果处理时间超过100ms
            console.warn('[聊天自动备份] 消息处理时间过长:', endTime - startTime, 'ms');
        }
    }
}

// 将现有的findTableDrawerElement函数替换为更健壮的版本
function findTableDrawerElement() {
    // 尝试查找表格抽屉元素
    const element = document.getElementById('table_drawer_content');
    if (element) {
        logDebug('[聊天自动备份] 成功找到表格抽屉元素');
    }
    return element;
}

// 添加新的轮询函数来重试查找表格抽屉元素
function setupTableDrawerObserver() {
    logDebug('[聊天自动备份] 开始设置表格抽屉监听器...');
    const MAX_RETRIES = 10, RETRY_INTERVAL = 500;
    let retryCount = 0;

    function attemptToSetupObserver() {
        // 将 observer 存为全局变量，便于 disconnect
        drawerObserverInstance = new MutationObserver(drawerObserverCallback);
        const element = findTableDrawerElement();
        if (element) {
            drawerObserverInstance.observe(element, { attributes: true, attributeFilter: ['style'] });
            logDebug('[聊天自动备份] 已成功设置表格抽屉监听器');
            // 处理初始状态 (如果抽屉默认是打开的)
            if (window.getComputedStyle(element).display !== 'none') {
                logDebug('[聊天自动备份] 表格抽屉在插件初始化时已打开。获取初始 chatMetadata 哈希...');
                const context = getContext();
                if (context && context.chatMetadata) {
                    try {
                        // 处理完整元数据
                        const metadataString = JSON.stringify(context.chatMetadata);
                        // 使用同步哈希函数无需await
                        metadataHashOnDrawerOpen = fastHash(metadataString);
                        logDebug(`[聊天自动备份] 初始打开状态的 chatMetadata 哈希: ${metadataHashOnDrawerOpen}`);
                    } catch (e) {
                        console.error('[聊天自动备份] 计算初始打开状态元数据哈希失败:', e);
                        metadataHashOnDrawerOpen = 'error_on_open';
                    }
                } else {
                    metadataHashOnDrawerOpen = null;
                }
            }
            return true; // 成功设置
        } else {
            retryCount++;
            if (retryCount < MAX_RETRIES) {
                // 继续重试
                logDebug(`[聊天自动备份] 未找到表格抽屉元素，${RETRY_INTERVAL}ms后重试...`);
                setTimeout(attemptToSetupObserver, RETRY_INTERVAL);
                return false; // 尚未成功设置
            } else {
                console.warn("[聊天自动备份] 达到最大重试次数，无法找到表格抽屉元素。");
                return false; // 最终失败
            }
        }
    }
    return attemptToSetupObserver();
}

// --- 添加快捷键恢复功能 ---
function setupKeyboardShortcuts() {
    // 跟踪按键状态
    const keysPressed = {
        'KeyA': false,
        'KeyS': false,
        'KeyD': false
    };
    
    // 键盘按下事件
    document.addEventListener('keydown', (event) => {
        // 如果正在输入框中，不触发快捷键
        if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') {
            return;
        }
        
        // 更新按键状态
        if (event.code in keysPressed) {
            keysPressed[event.code] = true;
        }
        
        // 检查是否所有必需的键都被按下
        if (keysPressed['KeyA'] && keysPressed['KeyS'] && keysPressed['KeyD']) {
            // 重置按键状态，防止重复触发
            keysPressed['KeyA'] = keysPressed['KeyS'] = keysPressed['KeyD'] = false;
            
            // 恢复最新备份
            restoreLatestBackup();
        }
    });
    
    // 键盘释放事件
    document.addEventListener('keyup', (event) => {
        // 更新按键状态
        if (event.code in keysPressed) {
            keysPressed[event.code] = false;
        }
    });
    
    // 页面失去焦点时重置所有按键状态
    window.addEventListener('blur', () => {
        Object.keys(keysPressed).forEach(key => {
            keysPressed[key] = false;
        });
    });
    
    logDebug('[聊天自动备份] 快捷键监听已设置 (A+S+D 同时按下可恢复最新备份)');
}

// 恢复最新备份的函数
async function restoreLatestBackup() {
    logDebug('[聊天自动备份] 通过快捷键尝试恢复最新备份');
    
    try {
        // 1. 获取所有备份的元数据 (轻量级)
        const allMetas = await getAllBackupsMeta();
        if (!allMetas || allMetas.length === 0) {
            toastr.warning('没有可用的备份', '快捷恢复');
            return;
        }

        // 2. 按时间戳排序找到最新的元数据
        allMetas.sort((a, b) => b.timestamp - a.timestamp);
        const latestMeta = allMetas[0];

        // 3. 使用元数据获取完整的备份数据
        toastr.info(`正在恢复 "${latestMeta.entityName} - ${latestMeta.chatName}" 的最新备份...`, '快捷恢复');
        const latestBackup = await getFullBackup(latestMeta.chatKey, latestMeta.timestamp);

        if (!latestBackup) {
            toastr.error('无法获取最新的备份内容', '快捷恢复');
            return;
        }

        // 4. 调用恢复功能，跳过确认对话框
        await restoreBackup(latestBackup);
        
        // 恢复成功通知已在restoreBackup函数中显示
    } catch (error) {
        console.error('[聊天自动备份] 快捷恢复最新备份时出错:', error);
        toastr.error(`恢复失败: ${error.message}`, '快捷恢复');
    }
}

// 修改为使用localStorage存储确认状态
// 不再使用简单的全局变量
function hasUserConfirmedRestore() {
    return localStorage.getItem('chat_backup_confirmed_restore') === 'true';
}

function setUserConfirmedRestore(confirmed) {
    localStorage.setItem('chat_backup_confirmed_restore', confirmed ? 'true' : 'false');
    logDebug(`[聊天自动备份] 用户恢复确认状态已保存为: ${confirmed}`);
}

// 添加一个函数来关闭扩展面板和备份UI
function closeExtensionsAndBackupUI() {
    // 关闭主扩展页面
    const extensionsBlock = $('#rm_extensions_block');
    if (extensionsBlock.length) {
        // 只使用SillyTavern的类和属性来关闭抽屉，移除强制的内联样式
        extensionsBlock.removeClass('openDrawer').addClass('closedDrawer');
        extensionsBlock.attr('data-slide-toggle', 'hidden');
        // extensionsBlock.css('display', 'none'); 
    }
    
    // 关闭备份UI的内容部分
    const backupContent = $('#chat_auto_backup_settings .inline-drawer-content');
    if (backupContent.length) {
        // 同样，只通过移除父元素的 'open' 类来关闭内部抽屉
        // backupContent.css('display', 'none'); // <-- 已移除此行
        const drawerParent = backupContent.closest('.inline-drawer');
        if (drawerParent.length) {
            drawerParent.removeClass('open');
        }
    }
}

// 添加使用说明按钮的点击事件和弹窗功能
function setupHelpButton() {
    // 首先确保使用说明按钮已添加到HTML中
    if ($('#chat_backup_help_button').length === 0) {
        const helpButton = $('<button id="chat_backup_help_button" class="menu_button">使用说明</button>');
        const backupButton = $('<button id="chat_backup_manual_backup" class="menu_button">立即备份</button>');
        
        // 创建包含两个按钮的容器
        const buttonContainer = $('<div class="chat_backup_control_item"></div>').append(helpButton).append(backupButton);
        
        // 将按钮容器添加到调试开关后面
        $('.chat_backup_controls .chat_backup_control_item:first').after(buttonContainer);
    }
    
    // 为使用说明按钮添加点击事件
    $(document).on('click', '#chat_backup_help_button', function() {
        showHelpPopup();
    });
    // 注意：备份按钮的点击事件已在 setupUIEvents 中绑定
}

// 使用说明弹窗内容和展示
function showHelpPopup() {
    const helpContent = `
    <div class="backup_help_popup">
        <style>
            .backup_help_popup {
                color: var(--SmText);
                font-family: Arial, sans-serif;
                line-height: 1.6;
                padding: 10px 20px;
                overflow-y: auto;
                max-height: 80vh;
                text-align: left;
            }
            .backup_help_popup h1 {
                font-size: 1.8em;
                color: var(--SmColor);
                margin-top: 30px;
                margin-bottom: 15px;
                padding-bottom: 8px;
                border-bottom: 1px solid var(--SmColor);
                text-align: left;
            }
            .backup_help_popup h1:first-child {
                margin-top: 10px;
            }
            .backup_help_popup p {
                margin: 12px 0;
                text-align: left;
            }
            .backup_help_popup ul, .backup_help_popup ol {
                margin: 15px 0;
                padding-left: 25px;
                text-align: left;
            }
            .backup_help_popup li {
                margin: 6px 0;
                text-align: left;
            }
            .backup_help_popup blockquote {
                background-color: rgba(128, 128, 128, 0.1);
                border-left: 4px solid var(--SmColor);
                margin: 20px 0;
                padding: 10px 15px;
                font-style: italic;
                text-align: left;
            }
            .backup_help_popup hr {
                border: none;
                height: 1px;
                background: linear-gradient(to right, transparent, var(--SmColor), transparent);
                margin: 25px 0;
            }
            .backup_help_popup strong {
                color: var(--SmColor);
                font-weight: bold;
            }
            .backup_help_popup code {
                background-color: rgba(0, 0, 0, 0.2);
                padding: 2px 4px;
                border-radius: 3px;
                font-family: monospace;
                font-size: 0.9em;
            }
            /* 只有最后的感谢信息居中 */
            .backup_help_popup .footer-thanks {
                text-align: center;
            }
        </style>
        <h1>插件介绍</h1>
        <p>该插件旨在帮助用户在<strong>聊天记录丢失</strong>（尤其是因<strong>切换预设、正则替换</strong>等情况）时，能够快速找回重要内容。</p>
        <ul>
            <li>插件会<strong>自动备份（默认）最近 3 条不同角色卡/群聊的聊天记录</strong>。</li>
            <li>每个角色卡/群聊的备份会<strong>实时更新</strong>为最新内容。</li>
            <li>若需增加备份角色卡/群聊数量，可在插件设置页面中进行调整。</li>
			<li><strong>最大角色/群组数</strong>表示备份的角色卡/群聊数量，而<strong>每组最大备份数</strong>则表示每个角色卡/群聊保存的最新备份数量。</li>
            <li><strong>最多支持 10 个角色卡/群聊</strong>，每组最多备份 <strong>3 条记录</strong>。</li>
        </ul>
        <blockquote>
            <p>注：防抖延迟与调试日志参数通常无需更改，主要供开发者调试使用。</p>
        </blockquote>
        <hr>
        <h1>使用方式</h1>

        <!-- 视频演示 -->
        <video 
            src="https://files.catbox.moe/xij4li.mp4" 
            autoplay 
            loop 
            muted 
            playsinline
            style="width: 100%; max-width: 500px; border-radius: 8px; margin: 10px auto; display: block;">
        </video>

        <ul>
            <li>点击每条备份右侧的 <code>恢复</code> 按钮，即可<strong>一键恢复</strong>至对应角色卡/群聊。</li>
            <li><strong>电脑用户</strong>支持快捷键，键盘同时按下 <code>A  S  D</code> 三个键，<strong>可以直接快速恢复</strong>备份记录，无需打开备份页面。</li>
            <li>点击 <code>预览</code> 可查看该备份中的<strong>最后两条对话消息</strong>。</li>
            <li><code>删除</code> 按钮用于<strong>移除当前备份</strong>。</li>
            <li><code>手动恢复</code> 按钮用于<strong>将该备份手动恢复到指定的角色卡中</strong>（用来解决插件错误的恢复备份到别的角色卡的特殊情况）。</li>
        </ul>
        <hr>
        <h1>其他说明</h1>
        <p>插件备份的聊天记录与原记录<strong>完全一致</strong>，包括作者注释、记忆表格等内容。</p>
        <p><strong>恢复操作通过酒馆的标准后端 API并使用轮询机制进行</strong>，确保数据完整且不会恢复失败。</p>
        <p>使用了 <strong>文本流处理技术</strong>，确保插件运行不会影响酒馆的性能或流畅度（卡顿）。</p>
        <hr>
        <p class="footer-thanks" style="font-style: italic; margin-top: 20px;">如有其他问题、BUG 或建议，欢迎随时反馈！</p>
    </div>`;

    // 使用ST的Popup系统创建弹窗
    const popup = new Popup(helpContent, POPUP_TYPE.DISPLAY, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true
    });
    popup.show();
}

// 缓存常用的正则表达式
const SPECIAL_TAGS_REGEX = {
    // 特殊标签 - 使用更严格的正则表达式
    tableEdit: /<tableEdit>[\s\S]*?<\/tableEdit>/g,
    tableEditAttr: /<tableEdit[\s\S]*?<\/tableEdit>/g, // 额外匹配可能带属性的标签
    think: /<think>[\s\S]*?<\/think>/g,
    thinking: /<thinking>[\s\S]*?<\/thinking>/g,
    // 表格相关标签
    table: /<table[\s\S]*?<\/table>/g,
    tableRow: /<tr[\s\S]*?<\/tr>/g,
    tableCell: /<td[\s\S]*?<\/td>/g,
    // 代码块
    codeBlockTicks: /```[\s\S]*?```/g,
    inlineCode: /`[^`\n]*?`/g,
    // Markdown格式
    bold: /\*\*(.*?)\*\*/g,
    italic: /\*(.*?)\*/g,
    strikethrough: /~~(.*?)~~/g,
    // HTML标签
    htmlPair: /<[^>]*>[^<]*<\/[^>]*>/g, // 成对的HTML标签及其内容
    htmlTag: /<[^>]+>/g,                // 单个HTML标签
    // 其他特殊格式
    doubleBrackets: /\[\[(.*?)\]\]/g,
    markdownLink: /\[(.*?)\]\(.*?\)/g,
    // HTML转义
    htmlEscape: {
        amp: /&/g,
        lt: /</g,
        gt: />/g,
        quot: /"/g,
        apos: /'/g
    }
};

// 使用缓存的正则表达式
function filterSpecialTags(text) {
    if (typeof text !== 'string') {
        return '';
    }
    
    // 1. 先过滤特殊标签和格式
    let filtered = text
        // 特殊标签
        .replace(SPECIAL_TAGS_REGEX.tableEdit, '')
        .replace(SPECIAL_TAGS_REGEX.tableEditAttr, '')
        .replace(SPECIAL_TAGS_REGEX.think, '')
        .replace(SPECIAL_TAGS_REGEX.thinking, '')
        // 表格相关标签
        .replace(SPECIAL_TAGS_REGEX.table, '')
        .replace(SPECIAL_TAGS_REGEX.tableRow, '')
        .replace(SPECIAL_TAGS_REGEX.tableCell, '')
        // 代码块
        .replace(SPECIAL_TAGS_REGEX.codeBlockTicks, '')
        .replace(SPECIAL_TAGS_REGEX.inlineCode, '')
        // Markdown格式 - 保留内容
        .replace(SPECIAL_TAGS_REGEX.bold, '$1')
        .replace(SPECIAL_TAGS_REGEX.italic, '$1')
        .replace(SPECIAL_TAGS_REGEX.strikethrough, '$1')
        // HTML标签
        .replace(SPECIAL_TAGS_REGEX.htmlPair, '')
        .replace(SPECIAL_TAGS_REGEX.htmlTag, '')
        // 其他特殊格式
        .replace(SPECIAL_TAGS_REGEX.doubleBrackets, '$1')
        .replace(SPECIAL_TAGS_REGEX.markdownLink, '$1');
    
    // 2. 清理多余空白
    filtered = filtered.replace(/\s+/g, ' ').trim();
    
    // 3. 然后进行 HTML 转义
    return filtered
        .replace(SPECIAL_TAGS_REGEX.htmlEscape.amp, "&amp;")
        .replace(SPECIAL_TAGS_REGEX.htmlEscape.lt, "&lt;")
        .replace(SPECIAL_TAGS_REGEX.htmlEscape.gt, "&gt;")
        .replace(SPECIAL_TAGS_REGEX.htmlEscape.quot, "&quot;")
        .replace(SPECIAL_TAGS_REGEX.htmlEscape.apos, "&#039;");

}

