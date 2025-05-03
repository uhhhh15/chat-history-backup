// Chat Auto Backup 插件 - 自动保存和恢复最近三次聊天记录
// 主要功能：
// 1. 自动保存最近聊天记录到IndexedDB (基于事件触发, 区分立即与防抖)
// 2. 在插件页面显示保存的记录
// 3. 提供恢复功能，将保存的聊天记录恢复到新的聊天中F
// 4. 使用Web Worker优化深拷贝性能

import {
    getContext,
    renderExtensionTemplateAsync,
    extension_settings,
} from '../../../extensions.js';

import {
    // --- 核心应用函数 ---
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
    characters,             // 需要访问角色列表来查找索引
    getThumbnailUrl,        // 可能需要获取头像URL（虽然备份里应该有）
    openCharacterChat,
    // --- 其他可能需要的函数 ---
    // clearChat, // 可能不需要，doNewChat 应该会处理
    // getCharacters, // 切换角色后可能需要更新？selectCharacterById 内部应该会处理
} from '../../../../script.js';

import {
    // --- 群组相关函数 ---
    select_group_chats,     // 用于选择群组聊天
    openGroupChat,
    // getGroupChat, // 可能不需要，select_group_chats 应该会处理
} from '../../../group-chats.js';

import {
    waitUntilCondition
} from '../../../utils.js';

// 扩展名和设置初始化
const PLUGIN_NAME = 'chat-history-backup';
const DEFAULT_SETTINGS = {
    maxTotalBackups: 3,        // 整个系统保留的最大备份数量
    backupDebounceDelay: 1000, // 防抖延迟时间 (毫秒)
    debug: true,               // 调试模式
};

// IndexedDB 数据库名称和版本
const DB_NAME = 'ST_ChatAutoBackup';
const DB_VERSION = 1;
const STORE_NAME = 'backups';

// Web Worker 实例 (稍后初始化)
let backupWorker = null;
// 用于追踪 Worker 请求的 Promise
const workerPromises = {};
let workerRequestId = 0;

// 数据库连接池 - 实现单例模式
let dbConnection = null;

// 备份状态控制
let isBackupInProgress = false; // 并发控制标志
let backupTimeout = null;       // 防抖定时器 ID

// --- 深拷贝逻辑 (将在Worker和主线程中使用) ---
const deepCopyLogicString = `
    const deepCopy = (obj) => {
        try {
            return structuredClone(obj);
        } catch (error) {
            try {
                return JSON.parse(JSON.stringify(obj));
            } catch (jsonError) {
                throw jsonError; // 抛出错误，让主线程知道
            }
        }
    };
`;

// --- 日志函数 ---
function logDebug(...args) {
    const settings = extension_settings[PLUGIN_NAME];
    if (settings && settings.debug) {
        console.log(`[聊天自动备份][${new Date().toLocaleTimeString()}]`, ...args);
    }
}

// --- 设置初始化 ---
function initSettings() {
    console.log('[聊天自动备份] 初始化插件设置');
    if (!extension_settings[PLUGIN_NAME]) {
        console.log('[聊天自动备份] 创建新的插件设置');
        extension_settings[PLUGIN_NAME] = { ...DEFAULT_SETTINGS };
    }

    // 确保设置结构完整
    const settings = extension_settings[PLUGIN_NAME];
    
    // 如果之前使用的是旧版设置，则迁移到新版
    if (settings.hasOwnProperty('maxBackupsPerChat') && !settings.hasOwnProperty('maxTotalBackups')) {
        settings.maxTotalBackups = 3; // 默认值
        delete settings.maxBackupsPerChat; // 移除旧设置
        console.log('[聊天自动备份] 从旧版设置迁移到新版设置');
    }
    
    // 确保所有设置都存在
    settings.maxTotalBackups = settings.maxTotalBackups ?? DEFAULT_SETTINGS.maxTotalBackups;
    settings.backupDebounceDelay = settings.backupDebounceDelay ?? DEFAULT_SETTINGS.backupDebounceDelay;
    settings.debug = settings.debug ?? DEFAULT_SETTINGS.debug;

    // 验证设置合理性
    if (typeof settings.maxTotalBackups !== 'number' || settings.maxTotalBackups < 1) {
        console.log(`[聊天自动备份] 无效的最大备份数 ${settings.maxTotalBackups}，重置为默认值 ${DEFAULT_SETTINGS.maxTotalBackups}`);
        settings.maxTotalBackups = DEFAULT_SETTINGS.maxTotalBackups;
    }
    
    if (typeof settings.backupDebounceDelay !== 'number' || settings.backupDebounceDelay < 300) {
        console.log(`[聊天自动备份] 无效的防抖延迟 ${settings.backupDebounceDelay}，重置为默认值 ${DEFAULT_SETTINGS.backupDebounceDelay}`);
        settings.backupDebounceDelay = DEFAULT_SETTINGS.backupDebounceDelay;
    }

    console.log('[聊天自动备份] 插件设置初始化完成:', settings);
    return settings;
}

// --- IndexedDB 相关函数 (优化版本) ---
// 初始化 IndexedDB 数据库
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
            logDebug('数据库打开成功');
            resolve(db);
        };

        request.onupgradeneeded = function(event) {
            const db = event.target.result;
            console.log('[聊天自动备份] 数据库升级中，创建对象存储');
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                const store = db.createObjectStore(STORE_NAME, { keyPath: ['chatKey', 'timestamp'] });
                store.createIndex('chatKey', 'chatKey', { unique: false });
                console.log('[聊天自动备份] 创建了备份存储和索引');
            }
        };
    });
}

// 获取数据库连接 (优化版本 - 使用连接池)
async function getDB() {
    try {
        // 检查现有连接是否可用
        if (dbConnection && dbConnection.readyState !== 'closed') {
            return dbConnection;
        }
        
        // 创建新连接
        dbConnection = await initDatabase();
        return dbConnection;
    } catch (error) {
        console.error('[聊天自动备份] 获取数据库连接失败:', error);
        throw error;
    }
}

// 保存备份到 IndexedDB (优化版本)
async function saveBackupToDB(backup) {
    const db = await getDB();
    try {
        await new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            
            transaction.oncomplete = () => {
                logDebug(`备份已保存到IndexedDB, 键: [${backup.chatKey}, ${backup.timestamp}]`);
                resolve();
            };
            
            transaction.onerror = (event) => {
                console.error('[聊天自动备份] 保存备份事务失败:', event.target.error);
                reject(event.target.error);
            };
            
            const store = transaction.objectStore(STORE_NAME);
            store.put(backup);
        });
    } catch (error) {
        console.error('[聊天自动备份] saveBackupToDB 失败:', error);
        throw error;
    }
}

// 从 IndexedDB 获取指定聊天的所有备份 (优化版本)
async function getBackupsForChat(chatKey) {
    const db = await getDB();
    try {
        return await new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly');
            
            transaction.onerror = (event) => {
                console.error('[聊天自动备份] 获取备份事务失败:', event.target.error);
                reject(event.target.error);
            };
            
            const store = transaction.objectStore(STORE_NAME);
            const index = store.index('chatKey');
            const request = index.getAll(chatKey);
            
            request.onsuccess = () => {
                const backups = request.result || [];
                logDebug(`从IndexedDB获取了 ${backups.length} 个备份，chatKey: ${chatKey}`);
                resolve(backups);
            };
            
            request.onerror = (event) => {
                console.error('[聊天自动备份] 获取备份失败:', event.target.error);
                reject(event.target.error);
            };
        });
    } catch (error) {
        console.error('[聊天自动备份] getBackupsForChat 失败:', error);
        return []; // 出错时返回空数组
    }
}

// 从 IndexedDB 获取所有备份 (优化版本)
async function getAllBackups() {
    const db = await getDB();
    try {
        return await new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly');
            
            transaction.onerror = (event) => {
                console.error('[聊天自动备份] 获取所有备份事务失败:', event.target.error);
                reject(event.target.error);
            };
            
            const store = transaction.objectStore(STORE_NAME);
            const request = store.getAll();
            
            request.onsuccess = () => {
                const backups = request.result || [];
                logDebug(`从IndexedDB获取了总共 ${backups.length} 个备份`);
                resolve(backups);
            };
            
            request.onerror = (event) => {
                console.error('[聊天自动备份] 获取所有备份失败:', event.target.error);
                reject(event.target.error);
            };
        });
    } catch (error) {
        console.error('[聊天自动备份] getAllBackups 失败:', error);
        return [];
    }
}

// 从 IndexedDB 获取所有备份的主键 (优化清理逻辑)
async function getAllBackupKeys() {
    const db = await getDB();
    try {
        return await new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly');

            transaction.onerror = (event) => {
                console.error('[聊天自动备份] 获取所有备份键事务失败:', event.target.error);
                reject(event.target.error);
            };

            const store = transaction.objectStore(STORE_NAME);
            // 使用 getAllKeys() 只获取主键
            const request = store.getAllKeys();

            request.onsuccess = () => {
                // 返回的是键的数组，每个键是 [chatKey, timestamp]
                const keys = request.result || [];
                logDebug(`从IndexedDB获取了总共 ${keys.length} 个备份的主键`);
                resolve(keys);
            };

            request.onerror = (event) => {
                console.error('[聊天自动备份] 获取所有备份键失败:', event.target.error);
                reject(event.target.error);
            };
        });
    } catch (error) {
        console.error('[聊天自动备份] getAllBackupKeys 失败:', error);
        return []; // 出错时返回空数组
    }
} 

// 从 IndexedDB 删除指定备份 (优化版本)
async function deleteBackup(chatKey, timestamp) {
    const db = await getDB();
    try {
        await new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            
            transaction.oncomplete = () => {
                logDebug(`已从IndexedDB删除备份, 键: [${chatKey}, ${timestamp}]`);
                resolve();
            };
            
            transaction.onerror = (event) => {
                console.error('[聊天自动备份] 删除备份事务失败:', event.target.error);
                reject(event.target.error);
            };
            
            const store = transaction.objectStore(STORE_NAME);
            store.delete([chatKey, timestamp]);
        });
    } catch (error) {
        console.error('[聊天自动备份] deleteBackup 失败:', error);
        throw error;
    }
}

// --- 聊天信息获取 (保持不变) ---
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

// --- Web Worker 通信 ---
// 发送数据到 Worker 并返回包含拷贝后数据的 Promise
function performDeepCopyInWorker(chat, metadata) {
    return new Promise((resolve, reject) => {
        if (!backupWorker) {
            return reject(new Error("Backup worker not initialized."));
        }

        const currentRequestId = ++workerRequestId;
        workerPromises[currentRequestId] = { resolve, reject };

        logDebug(`[主线程] 发送数据到 Worker (ID: ${currentRequestId}), Chat长度: ${chat?.length}`);
        try {
             // 只发送需要拷贝的数据，减少序列化开销
            backupWorker.postMessage({
                id: currentRequestId,
                payload: { chat, metadata }
            });
        } catch (error) {
             console.error(`[主线程] 发送消息到 Worker 失败 (ID: ${currentRequestId}):`, error);
             delete workerPromises[currentRequestId];
             reject(error);
        }
    });
}

// --- 核心备份逻辑 (接收 settings 作为参数) ---
async function executeBackupLogic(settings) {
    const currentTimestamp = Date.now();
    logDebug(`开始执行核心备份逻辑 @ ${new Date(currentTimestamp).toLocaleTimeString()}`);

    // 1. 前置检查
    const chatKey = getCurrentChatKey();
    if (!chatKey) {
        console.warn('[聊天自动备份] 无有效的聊天标识符，取消备份');
        return false; // 返回 false 表示备份未执行
    }

    const context = getContext();
    const { chat, chat_metadata } = context;

    if (!chat || chat.length === 0) {
        logDebug('聊天记录为空，取消备份');
        return false; // 返回 false 表示备份未执行
    }

    const { entityName, chatName } = getCurrentChatInfo();
    const lastMsgIndex = chat.length - 1;
    const lastMessage = chat[lastMsgIndex];
    const lastMessagePreview = lastMessage?.mes?.substring(0, 100) || '(空消息)';

    logDebug(`准备备份聊天: ${entityName} - ${chatName}, 消息数: ${chat.length}, 最后消息ID: ${lastMsgIndex}`);

    try {
        // 2. 使用 Worker 进行深拷贝 (或者主线程回退，如果Worker失败)
        let copiedChat, copiedMetadata;
        if (backupWorker) {
            try {
                console.time('[聊天自动备份] Web Worker 深拷贝时间');
                logDebug('请求 Worker 执行深拷贝...');
                const result = await performDeepCopyInWorker(chat, chat_metadata);
                copiedChat = result.chat;
                copiedMetadata = result.metadata;
                console.timeEnd('[聊天自动备份] Web Worker 深拷贝时间');
                logDebug('从 Worker 收到拷贝后的数据');
            } catch(workerError) {
                 console.error('[聊天自动备份] Worker 深拷贝失败，将尝试在主线程执行:', workerError);
                 // Worker失败，尝试主线程回退（如果需要）
                 console.time('[聊天自动备份] 主线程深拷贝时间 (Worker失败后)');
                 try {
                     copiedChat = structuredClone(chat);
                     copiedMetadata = structuredClone(chat_metadata);
                 } catch (structuredCloneError) {
                    try {
                        copiedChat = JSON.parse(JSON.stringify(chat));
                        copiedMetadata = JSON.parse(JSON.stringify(chat_metadata));
                    } catch (jsonError) {
                        console.error('[聊天自动备份] 主线程深拷贝也失败:', jsonError);
                        throw new Error("无法完成聊天数据的深拷贝"); // 抛出错误终止备份
                    }
                 }
                 console.timeEnd('[聊天自动备份] 主线程深拷贝时间 (Worker失败后)');
            }
        } else {
            // Worker 不可用，直接在主线程执行
            console.time('[聊天自动备份] 主线程深拷贝时间 (无Worker)');
            try {
                 copiedChat = structuredClone(chat);
                 copiedMetadata = structuredClone(chat_metadata);
             } catch (structuredCloneError) {
                try {
                    copiedChat = JSON.parse(JSON.stringify(chat));
                    copiedMetadata = JSON.parse(JSON.stringify(chat_metadata));
                } catch (jsonError) {
                    console.error('[聊天自动备份] 主线程深拷贝失败:', jsonError);
                    throw new Error("无法完成聊天数据的深拷贝"); // 抛出错误终止备份
                }
             }
            console.timeEnd('[聊天自动备份] 主线程深拷贝时间 (无Worker)');
        }


        if (!copiedChat) {
             throw new Error("未能获取有效的聊天数据副本");
        }

        // 3. 构建备份对象
        const backup = {
            timestamp: currentTimestamp,
            chatKey,
            entityName,
            chatName,
            lastMessageId: lastMsgIndex,
            lastMessagePreview,
            chat: copiedChat,
            metadata: copiedMetadata || {}
        };

        // 4. 检查当前聊天是否已有基于最后消息ID的备份 (避免完全相同的备份)
        const existingBackups = await getBackupsForChat(chatKey); // 获取当前聊天的备份

        // 5. 检查重复并处理 (基于 lastMessageId)
        const existingBackupIndex = existingBackups.findIndex(b => b.lastMessageId === lastMsgIndex);
        let needsSave = true;

        if (existingBackupIndex !== -1) {
             // 如果找到相同 lastMessageId 的备份
            const existingTimestamp = existingBackups[existingBackupIndex].timestamp;
            if (backup.timestamp > existingTimestamp) {
                // 新备份更新，删除旧的同 ID 备份
                logDebug(`发现具有相同最后消息ID (${lastMsgIndex}) 的旧备份 (时间戳 ${existingTimestamp})，将删除旧备份以便保存新备份 (时间戳 ${backup.timestamp})`);
                await deleteBackup(chatKey, existingTimestamp);
                // 注意：不需要从 existingBackups 数组中 splice，因为它不再用于全局清理
            } else {
                // 旧备份更新或相同，跳过本次保存
                logDebug(`发现具有相同最后消息ID (${lastMsgIndex}) 且时间戳更新或相同的备份 (时间戳 ${existingTimestamp} vs ${backup.timestamp})，跳过本次保存`);
                needsSave = false;
            }
        }

        if (!needsSave) {
            logDebug('备份已存在或无需更新 (基于lastMessageId和时间戳比较)，跳过保存和全局清理步骤');
            return false; // 不需要保存，返回 false
        }

        // 6. 保存新备份到 IndexedDB
        await saveBackupToDB(backup);
        logDebug(`新备份已保存: [${chatKey}, ${backup.timestamp}]`);

        // --- 优化后的清理逻辑 ---
        // 7. 获取所有备份的 *主键* 并限制总数量
        logDebug(`获取所有备份的主键，以检查是否超出系统限制 (${settings.maxTotalBackups})`);
        const allBackupKeys = await getAllBackupKeys(); // 调用新函数，只获取键

        if (allBackupKeys.length > settings.maxTotalBackups) {
            logDebug(`总备份数 (${allBackupKeys.length}) 超出系统限制 (${settings.maxTotalBackups})`);

            // 按时间戳升序排序键 (key[1] 是 timestamp)
            // 这样最旧的备份的键会排在数组前面
            allBackupKeys.sort((a, b) => a[1] - b[1]); // a[1] = timestamp, b[1] = timestamp

            const numToDelete = allBackupKeys.length - settings.maxTotalBackups;
            // 获取数组开头的 numToDelete 个键，这些是需要删除的最旧备份的键
            const keysToDelete = allBackupKeys.slice(0, numToDelete);

            logDebug(`准备删除 ${keysToDelete.length} 个最旧的备份 (基于键)`);

            // 使用Promise.all并行删除
            await Promise.all(keysToDelete.map(key => {
                const oldChatKey = key[0];
                const oldTimestamp = key[1];
                logDebug(`删除旧备份 (基于键): chatKey=${oldChatKey}, timestamp=${new Date(oldTimestamp).toLocaleString()}`);
                // 调用 deleteBackup，它接受 chatKey 和 timestamp
                return deleteBackup(oldChatKey, oldTimestamp);
            }));
            logDebug(`${keysToDelete.length} 个旧备份已删除`);
        } else {
            logDebug(`总备份数 (${allBackupKeys.length}) 未超出限制 (${settings.maxTotalBackups})，无需清理`);
        }
        // --- 清理逻辑结束 ---

        // 8. UI提示
        logDebug(`成功完成聊天备份及可能的清理: ${entityName} - ${chatName}`);

        return true; // 表示备份成功（或已跳过但无错误）

    } catch (error) {
        console.error('[聊天自动备份] 备份或清理过程中发生严重错误:', error);
        toastr.error(`备份失败: ${error.message || '未知错误'}`, '聊天自动备份');
        // 返回 false 表示备份/清理操作失败
        return false;
    }
}

// --- 条件备份函数 (类似 saveChatConditional) ---
async function performBackupConditional() {
    if (isBackupInProgress) {
        logDebug('备份已在进行中，跳过本次请求');
        return;
    }

    // 获取当前设置，包括防抖延迟，以防在延迟期间被修改
    const currentSettings = extension_settings[PLUGIN_NAME];
    if (!currentSettings) {
        console.error('[聊天自动备份] 无法获取当前设置，取消备份');
        return;
    }

    logDebug('执行条件备份 (performBackupConditional)');
    clearTimeout(backupTimeout); // 取消任何待处理的防抖备份
    backupTimeout = null;

    isBackupInProgress = true;
    logDebug('设置备份锁');
    try {
        const success = await executeBackupLogic(currentSettings); // 传递设置给核心逻辑
        if (success) {
            await updateBackupsList(); // 只有在备份成功或无需备份时才更新列表
        }
    } catch (error) {
        console.error('[聊天自动备份] 条件备份执行失败:', error);
        // 错误已在 executeBackupLogic 中处理和提示
    } finally {
        isBackupInProgress = false;
        logDebug('释放备份锁');
    }
}

// --- 防抖备份函数 (类似 saveChatDebounced) ---
function performBackupDebounced() {
    // 获取调用时的上下文和设置
    const scheduledChatKey = getCurrentChatKey();
    const currentSettings = extension_settings[PLUGIN_NAME];

    if (!scheduledChatKey) {
        logDebug('无法获取计划防抖备份时的 ChatKey，取消');
        clearTimeout(backupTimeout);
        backupTimeout = null;
        return;
    }
    
    if (!currentSettings || typeof currentSettings.backupDebounceDelay !== 'number') {
        console.error('[聊天自动备份] 无法获取有效的防抖延迟设置，取消防抖');
        clearTimeout(backupTimeout);
        backupTimeout = null;
        return;
    }
    
    const delay = currentSettings.backupDebounceDelay; // 使用当前设置的延迟

    logDebug(`计划执行防抖备份 (延迟 ${delay}ms), 针对 ChatKey: ${scheduledChatKey}`);
    clearTimeout(backupTimeout); // 清除旧的定时器

    backupTimeout = setTimeout(async () => {
        const currentChatKey = getCurrentChatKey(); // 获取执行时的 ChatKey

        // 关键: 上下文检查
        if (currentChatKey !== scheduledChatKey) {
            logDebug(`上下文已更改 (当前: ${currentChatKey}, 计划时: ${scheduledChatKey})，取消此防抖备份`);
            backupTimeout = null;
            return; // 中止备份
        }

        logDebug(`执行延迟的备份操作 (来自防抖), ChatKey: ${currentChatKey}`);
        // 只有上下文匹配时才执行条件备份
        await performBackupConditional();
        backupTimeout = null; // 清除定时器 ID
    }, delay);
}

// --- 手动备份 ---
async function performManualBackup() {
    console.log('[聊天自动备份] 执行手动备份 (调用条件函数)');
    await performBackupConditional(); // 手动备份也走条件检查和锁逻辑
    toastr.success('已手动备份当前聊天', '聊天自动备份');
}

// --- 工具函数：等待 CHAT_CHANGED 事件 ---
// 功能：返回一个 Promise，该 Promise 在 CHAT_CHANGED 事件触发且满足特定条件时 resolve，
//       或者在超时后 reject。
function waitForChatChange(expectedConditionFn, description, timeoutMs = 7000) {
    return new Promise((resolve, reject) => {
        let listener;
        logDebug(`waitForChatChange: 开始等待 "${description}" (超时: ${timeoutMs}ms)`);

        const timeout = setTimeout(() => {
            if (listener) {
                // *** 修改点：使用 removeListener ***
                eventSource.removeListener(event_types.CHAT_CHANGED, listener);
                logDebug(`waitForChatChange: 等待 "${description}" (CHAT_CHANGED) 超时!`);
            }
            reject(new Error(`等待 "${description}" (CHAT_CHANGED) 超时 (${timeoutMs}ms)`));
        }, timeoutMs);

        listener = (receivedChatId) => {
            const currentContext = getContext();
            logDebug(`waitForChatChange: 收到 CHAT_CHANGED 事件 (ID: ${receivedChatId}), 检查条件 "${description}"...`);
            if (expectedConditionFn(receivedChatId, currentContext)) {
                logDebug(`waitForChatChange: 条件满足 ("${description}"). Received Chat ID: ${receivedChatId}`);
                clearTimeout(timeout);
                // *** 修改点：使用 removeListener ***
                eventSource.removeListener(event_types.CHAT_CHANGED, listener);
                requestAnimationFrame(() => resolve(receivedChatId));
            } else {
                logDebug(`waitForChatChange: 条件未满足 ("${description}"). Received Chat ID: ${receivedChatId}, Context Group: ${currentContext.groupId}, Context Char: ${currentContext.characterId}, Context Chat: ${currentContext.chatId}. 继续等待...`);
            }
        };
        // 添加监听器仍然是 .on
        eventSource.on(event_types.CHAT_CHANGED, listener);
    });
}

// --- 恢复逻辑 ---
// index.js (内部的 restoreBackup 函数 - 审查和优化)
async function restoreBackup(backupData) {
    console.log('[聊天自动备份] 开始恢复备份:', { chatKey: backupData.chatKey, timestamp: backupData.timestamp });
    const isGroup = backupData.chatKey.startsWith('group_');
    const entityIdMatch = backupData.chatKey.match(
        isGroup ? /group_(\w+)_/ : /^char_(\d+)/
    );
    let entityId = entityIdMatch ? entityIdMatch[1] : null;

    if (!entityId) {
        console.error('[聊天自动备份] 无法从备份数据中提取角色/群组ID:', backupData.chatKey);
        toastr.error('无法识别备份对应的角色/群组ID');
        return false;
    }

    const entityToRestore = {
        isGroup: isGroup,
        id: entityId, // 群组是 ID，角色是索引字符串
        charIndex: -1 // 如果是角色，需要找到数字索引
    };

    if (!isGroup) {
        entityToRestore.charIndex = parseInt(entityId, 10);
        if (isNaN(entityToRestore.charIndex) || entityToRestore.charIndex < 0 || entityToRestore.charIndex >= characters.length) {
            console.error(`[聊天自动备份] 角色索引无效: ${entityId}`);
            toastr.error(`无效的角色索引 ${entityId}`);
            return false;
        }
    }

    logDebug(`恢复目标: ${isGroup ? '群组' : '角色'} ID/索引: ${entityToRestore.isGroup ? entityToRestore.id : entityToRestore.charIndex}`);

    let newChatId = null; // 将用于存储新创建的聊天ID

    try {
        // --- 步骤 1: 切换上下文 (如果需要) ---
        const initialContext = getContext();
        const needsContextSwitch = (isGroup && initialContext.groupId !== entityToRestore.id) ||
                                   (!isGroup && String(initialContext.characterId) !== String(entityToRestore.charIndex));

        if (needsContextSwitch) {
            logDebug('步骤 1: 需要切换上下文，开始切换...');
            const switchPromise = isGroup
                ? select_group_chats(entityToRestore.id)
                : selectCharacterById(entityToRestore.charIndex, { switchMenu: false });

            try {
                await switchPromise; // 等待切换函数本身的 Promise 完成 (如果它返回的话)
                logDebug('步骤 1: 切换函数调用完成，等待 CHAT_CHANGED 确认...');
                // 等待 CHAT_CHANGED 事件确认上下文确实已更新
                await waitForChatChange(
                    (receivedChatId, currentContext) => { // 检查函数
                        return (isGroup && currentContext.groupId === entityToRestore.id) ||
                               (!isGroup && String(currentContext.characterId) === String(entityToRestore.charIndex));
                    },
                    `切换到 ${isGroup ? '群组' : '角色'} ${entityToRestore.isGroup ? entityToRestore.id : entityToRestore.charIndex}` // 描述
                );
                logDebug('步骤 1: 上下文切换完成并已通过 CHAT_CHANGED 确认');
            } catch (error) {
                console.error('[聊天自动备份] 步骤 1 失败: 切换或等待确认失败:', error);
                toastr.error(`切换上下文失败: ${error.message || '未知错误'}`);
                return false;
            }
        } else {
            logDebug('步骤 1: 当前已在目标上下文，跳过切换');
        }

        // --- 步骤 2: 创建新聊天 ---
        const contextBeforeNewChat = getContext();
        const originalChatIdBeforeNewChat = contextBeforeNewChat.chatId;
        logDebug(`步骤 2: 开始创建新聊天... (当前 chatId: ${originalChatIdBeforeNewChat})`);
        try {
            await doNewChat({ deleteCurrentChat: false });
            logDebug('步骤 2: doNewChat 调用完成，等待 CHAT_CHANGED 确认新聊天 ID...');

            // 等待 CHAT_CHANGED 事件，确认 chatId 已经改变
            newChatId = await waitForChatChange(
                (receivedChatId, currentContext) => { // 检查函数
                    // 条件：收到的 chatId 存在且不同于创建前的 chatId
                    return receivedChatId && receivedChatId !== originalChatIdBeforeNewChat;
                },
                "确认新聊天创建" // 描述
            );
            logDebug(`步骤 2: 新聊天创建并确认完成，新聊天 ID: ${newChatId}`);
        } catch (error) {
            console.error('[聊天自动备份] 步骤 2 失败: 创建新聊天或等待确认失败:', error);
            toastr.error(`创建新聊天失败: ${error.message || '未知错误'}`);
            return false;
        }

        // --- 步骤 3: (隐式完成) 获取新聊天 ID 已在步骤 2 完成 ---

        // --- 步骤 4: 准备聊天内容和元数据 ---
        logDebug('步骤 4: 准备内存中的聊天内容和元数据...');
        let chatToSave, metadataToSave;
        try {
            chatToSave = structuredClone(backupData.chat);
            metadataToSave = structuredClone(backupData.metadata || {});
            logDebug('步骤 4: 使用 structuredClone 成功拷贝数据');
        } catch (cloneError) {
            logDebug('步骤 4: structuredClone 失败，尝试 JSON 序列化回退...');
            try {
                chatToSave = JSON.parse(JSON.stringify(backupData.chat));
                metadataToSave = JSON.parse(JSON.stringify(backupData.metadata || {}));
                logDebug('步骤 4: 使用 JSON 序列化成功拷贝数据');
            } catch (jsonError) {
                console.error('[聊天自动备份] 步骤 4 失败: 深拷贝聊天数据失败:', jsonError);
                toastr.error('准备恢复数据时出错');
                return false;
            }
        }
        // (可以添加元数据调整逻辑，如重命名)
        // metadataToSave.name = `恢复自 ${new Date(backupData.timestamp).toLocaleDateString()}`;
        logDebug(`步骤 4: 准备完成, 消息数: ${chatToSave.length}, 元数据:`, metadataToSave);

        // --- 步骤 5: 保存恢复的数据到新聊天文件 ---
        logDebug(`步骤 5: 准备保存恢复数据到新文件 "${newChatId}"...`);
        let globalContext = getContext();
        // *** 再次确认当前上下文是新创建的聊天 ***
        if (globalContext.chatId !== newChatId) {
            console.error(`[聊天自动备份] 步骤 5 错误: 上下文意外切换! 预期: ${newChatId}, 实际: ${globalContext.chatId}. 中止保存。`);
            toastr.error('保存恢复数据前上下文检查失败，操作中止。');
            return false;
        }
        logDebug(`步骤 5: 上下文确认 (${newChatId}). 临时替换全局 chat 和 metadata...`);
        let originalGlobalChat = globalContext.chat.slice();
        let originalGlobalMetadata = structuredClone(globalContext.chat_metadata);

        try {
            // 修改全局状态以匹配要保存的内容
            globalContext.chat.length = 0;
            chatToSave.forEach(msg => globalContext.chat.push(msg));
            updateChatMetadata(metadataToSave, true); // true 表示完全替换

            logDebug(`步骤 5: 即将调用 saveChat({ chatName: "${newChatId}", force: true }) ...`);
            await saveChat({ chatName: newChatId, force: true });
            logDebug('步骤 5: saveChat 调用完成');
        } catch (saveError) {
            console.error("[聊天自动备份] 步骤 5 失败: saveChat 调用时出错:", saveError);
            toastr.error(`保存恢复的聊天失败: ${saveError.message}`, '聊天自动备份');
            // 回滚内存状态并返回
            globalContext.chat.length = 0;
            originalGlobalChat.forEach(msg => globalContext.chat.push(msg));
            updateChatMetadata(originalGlobalMetadata, true);
            return false;
        } finally {
            // 无论成功失败，恢复全局内存状态到 saveChat 调用前的状态（空聊天状态）
            globalContext.chat.length = 0;
            originalGlobalChat.forEach(msg => globalContext.chat.push(msg));
            updateChatMetadata(originalGlobalMetadata, true);
            logDebug('步骤 5: 全局 chat 和 metadata 已恢复到保存前状态');
        }

        // --- 步骤 6: 强制重加载 UI (Close/Reopen Hack - 使用更可靠的等待) ---
        logDebug('步骤 6: 开始强制重加载流程 (关闭 -> 重选 -> 打开恢复的聊天)...');
        try {
            // 6a: 触发关闭聊天
            logDebug("步骤 6a: 触发 '关闭聊天' ...");
            const closeButton = document.getElementById('option_close_chat');
            if (!closeButton) throw new Error("未能找到 #option_close_chat 按钮");
            closeButton.click();
            // 添加短暂延迟，确保事件循环处理点击
            await new Promise(resolve => requestAnimationFrame(resolve)); // 等待下一帧
            logDebug("步骤 6a: '关闭聊天' 已触发，继续后续步骤...");

            // 6b: 触发重新选择目标实体并等待确认
            logDebug(`步骤 6b: 重新选择目标 ${entityToRestore.isGroup ? '群组' : '角色'} ID/索引: ${entityToRestore.isGroup ? entityToRestore.id : entityToRestore.charIndex} 并等待 CHAT_CHANGED 确认实体加载...`);
            const reselectPromise = entityToRestore.isGroup
                ? select_group_chats(entityToRestore.id)
                : selectCharacterById(entityToRestore.charIndex, { switchMenu: false });

            await reselectPromise; // 等待选择函数本身的 Promise
            // 等待 CHAT_CHANGED 确认实体已加载 (加载的是默认聊天或上次聊天)
            await waitForChatChange(
                (receivedChatId, currentContext) => { // 检查函数
                    return (isGroup && currentContext.groupId === entityToRestore.id) ||
                           (!isGroup && String(currentContext.characterId) === String(entityToRestore.charIndex));
                },
                `确认重新选择 ${isGroup ? '群组' : '角色'} ${entityToRestore.isGroup ? entityToRestore.id : entityToRestore.charIndex}` // 描述
            );
            logDebug("步骤 6b: 目标实体已重新加载并确认");

            // 6c: 显式打开刚刚保存了数据的聊天文件
            logDebug(`步骤 6c: 显式打开恢复后的聊天文件: "${newChatId}" 并等待 CHAT_CHANGED 确认加载...`);
            const openRestoredPromise = isGroup
                ? openGroupChat(entityToRestore.id, newChatId) // 群组需要 entityId 和 chatId
                : openCharacterChat(newChatId);             // 角色只需要 chatId (文件名)

            await openRestoredPromise; // 等待打开函数本身的 Promise
            // 等待 CHAT_CHANGED 确认我们 *精确地* 加载了恢复的聊天
            await waitForChatChange(
                (receivedChatId, currentContext) => { // 检查函数
                    // 条件：收到的 chatId 必须等于我们恢复到的那个 chatId
                    return receivedChatId === newChatId;
                },
                `确认打开恢复的聊天 "${newChatId}"` // 描述
            );
            logDebug(`步骤 6c: 已成功加载并确认恢复的聊天: "${newChatId}"`);

            logDebug('步骤 6: 关闭再打开流程完成，UI 应已正确加载恢复的聊天');

        } catch (reloadError) {
            console.error('[聊天自动备份] 步骤 6 失败: 关闭或重新打开聊天时出错:', reloadError);
            toastr.error(`重新加载恢复的聊天内容失败: ${reloadError.message || '未知错误'}. 数据已保存为 "${newChatId}"，请尝试手动切换。`);
            // 尽管 UI 加载可能失败，但数据已保存，流程继续，返回 true
        }

        // --- 步骤 7: (可选) 可以移除手动触发 CHAT_CHANGED 的代码 ---

        // --- 结束 ---
        console.log('[聊天自动备份] 恢复流程完成');
        toastr.success(`聊天记录已成功恢复到新聊天 "${newChatId}"`);
        return true; // 表示恢复操作（数据保存）成功

    } catch (error) {
        // 捕获整个流程中未被内部 catch 处理的意外错误
        console.error('[聊天自动备份] 恢复聊天过程中发生未预料的严重错误:', error);
        toastr.error(`恢复失败: ${error.message || '未知错误'}`, '聊天自动备份');
        return false;
    } finally {
        // 可以在这里添加通用的清理逻辑，例如恢复按钮状态（如果在这个函数内管理的话）
        logDebug('[聊天自动备份] 恢复函数执行完毕 (finally)');
    }
}

// --- UI 更新 ---
async function updateBackupsList() {
    console.log('[聊天自动备份] 开始更新备份列表UI');
    const backupsContainer = $('#chat_backup_list');
    if (!backupsContainer.length) {
        console.warn('[聊天自动备份] 找不到备份列表容器元素 #chat_backup_list');
        return;
    }

    backupsContainer.html('<div class="backup_empty_notice">正在加载备份...</div>');

    try {
        const allBackups = await getAllBackups();
        backupsContainer.empty(); // 清空

        if (allBackups.length === 0) {
            backupsContainer.append('<div class="backup_empty_notice">暂无保存的备份</div>');
            return;
        }

        // 按时间降序排序
        allBackups.sort((a, b) => b.timestamp - a.timestamp);
        logDebug(`渲染 ${allBackups.length} 个备份`);

        allBackups.forEach(backup => {
            const date = new Date(backup.timestamp);
            // 使用更可靠和本地化的格式
            const formattedDate = date.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' });

            const backupItem = $(`
                <div class="backup_item">
                    <div class="backup_info">
                        <div class="backup_header">
                            <span class="backup_entity" title="${backup.entityName}">${backup.entityName || '未知实体'}</span>
                            <span class="backup_chat" title="${backup.chatName}">${backup.chatName || '未知聊天'}</span>
                        </div>
                         <div class="backup_details">
                            <span class="backup_mesid">最新楼: #${backup.lastMessageId}</span>
                            <span class="backup_date">${formattedDate}</span>
                        </div>
                        <div class="backup_preview" title="${backup.lastMessagePreview}">${backup.lastMessagePreview}...</div>
                    </div>
                    <div class="backup_actions">
                        <button class="menu_button backup_preview_btn" title="预览此备份内容" data-timestamp="${backup.timestamp}" data-key="${backup.chatKey}">预览</button>
                        <button class="menu_button backup_restore" title="恢复此备份到新聊天" data-timestamp="${backup.timestamp}" data-key="${backup.chatKey}">恢复</button>
                        <button class="menu_button danger_button backup_delete" title="删除此备份" data-timestamp="${backup.timestamp}" data-key="${backup.chatKey}">删除</button>
                    </div>
                </div>
            `);
            backupsContainer.append(backupItem);
        });

        console.log('[聊天自动备份] 备份列表渲染完成');
    } catch (error) {
        console.error('[聊天自动备份] 更新备份列表失败:', error);
        backupsContainer.html(`<div class="backup_empty_notice">加载备份列表失败: ${error.message}</div>`);
    }
}

function createPreviewModal(title, messages) {
    // 创建遮罩层，阻止任何事件穿透到下面的元素
    const modalOverlay = document.createElement('div');
    modalOverlay.id = 'backup_preview_overlay';
    modalOverlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        background-color: rgba(0, 0, 0, 0.85);
        z-index: 99999;
        display: flex;
        justify-content: center;
        align-items: center;
        pointer-events: all;
    `;
    
    // 准备消息内容HTML
    const messagesHtml = messages.slice(-2).map(msg => {
        let messageContent = msg.mes || '';
        messageContent = messageContent.replace(/<think>[\s\S]*?<\/think>/gi, '');
        messageContent = messageContent.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
        
        return `
            <div style="margin-bottom:15px; padding:10px; border-radius:8px; background-color:${msg.is_user ? 'rgba(0,120,255,0.15)' : 'rgba(128,0,128,0.15)'}; color:rgba(255,255,255,0.9);">
                <div style="font-weight:bold; margin-bottom:5px;">${msg.name || (msg.is_user ? '用户' : '助手')}</div>
                <div style="white-space:pre-wrap;">${messageContent}</div>
            </div>
        `;
    }).join('');
    
    // 创建内容HTML
    modalOverlay.innerHTML = `
        <div style="background-color:#121212; border:1px solid #444; border-radius:10px; width:80%; max-width:800px; max-height:80vh; display:flex; flex-direction:column; box-shadow:0 5px 15px rgba(0,0,0,0.8); position:relative; overflow:hidden; pointer-events: auto;">
            <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 15px; border-bottom:1px solid #444; background-color:#000000;">
                <h3 style="margin:0; color:#fff;">${title}</h3>
                <span id="backup_preview_close" style="cursor:pointer; font-size:1.5em; color:#fff;">&times;</span>
            </div>
            <div style="padding:15px; overflow-y:auto; max-height:calc(80vh - 50px); color:#ddd;">
                <div style="text-align:center; color:rgba(255,255,255,0.6); margin-bottom:15px; font-style:italic;">
                    共 ${messages.length} 条消息，仅显示最后 2 条
                </div>
                ${messages.length > 2 ? '<div style="margin:20px 0; height:2px; background-color:rgba(255,255,255,0.2); position:relative;"><div style="position:absolute; top:-10px; left:50%; transform:translateX(-50%); background-color:#121212; padding:0 10px; color:rgba(255,255,255,0.6);">...</div></div>' : ''}
                ${messagesHtml}
            </div>
        </div>
    `;
    
    // 先移除可能已存在的遮罩
    const existingOverlay = document.getElementById('backup_preview_overlay');
    if (existingOverlay) {
        document.body.removeChild(existingOverlay);
    }
    
    // 将遮罩添加到文档
    document.body.appendChild(modalOverlay);
    
    // 添加关闭事件 - 用原生JavaScript而不是jQuery
    document.getElementById('backup_preview_close').addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        document.body.removeChild(modalOverlay);
    });
    
    // 点击背景关闭
    modalOverlay.addEventListener('click', function(e) {
        if (e.target === modalOverlay) {
            e.preventDefault();
            e.stopPropagation();
            document.body.removeChild(modalOverlay);
        }
    });
    
    return modalOverlay;
}

async function previewBackup(chatKey, timestamp) {
    try {
        logDebug(`预览备份, chatKey: ${chatKey}, timestamp: ${timestamp}`);
        const db = await getDB();
        
        // 获取备份数据
        const backup = await new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly');
            transaction.onerror = (event) => reject(event.target.error);
            
            const store = transaction.objectStore(STORE_NAME);
            const request = store.get([chatKey, timestamp]);
            
            request.onsuccess = () => resolve(request.result);
            request.onerror = (event) => reject(event.target.error);
        });
        
        if (!backup || !backup.chat || !Array.isArray(backup.chat)) {
            toastr.error('无法加载备份内容或备份格式无效');
            return;
        }
        
        // 创建预览容器 (直接添加到body)
        const previewContainer = document.createElement('div');
        previewContainer.id = 'backup_preview_container';
        previewContainer.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            background-color: rgba(0, 0, 0, 0.85);
            z-index: 99999;
            display: flex;
            justify-content: center;
            align-items: center;
        `;
        
        // 创建内容容器
        const contentBox = document.createElement('div');
        contentBox.style.cssText = `
            background-color: #121212;
            border: 1px solid #444;
            border-radius: 10px;
            width: 80%;
            max-width: 800px;
            max-height: 80vh;
            display: flex;
            flex-direction: column;
            box-shadow: 0 5px 15px rgba(0, 0, 0, 0.8);
            overflow: hidden;
        `;
        
        // 创建头部
        const header = document.createElement('div');
        header.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 15px;
            border-bottom: 1px solid #444;
            background-color: #000000;
        `;
        
        const title = document.createElement('h3');
        title.style.cssText = `margin: 0; color: #fff;`;
        title.textContent = `${backup.entityName} - ${backup.chatName}`;
        
        const closeBtn = document.createElement('span');
        closeBtn.style.cssText = `cursor: pointer; font-size: 1.5em; color: #fff;`;
        closeBtn.textContent = '×';
        closeBtn.onclick = function(e) {
            e.preventDefault();
            e.stopPropagation();
            document.body.removeChild(previewContainer);
        };
        
        header.appendChild(title);
        header.appendChild(closeBtn);
        
        // 创建消息容器
        const msgContainer = document.createElement('div');
        msgContainer.style.cssText = `
            padding: 15px;
            overflow-y: auto;
            max-height: calc(80vh - 50px);
            color: #ddd;
        `;
        
        // 添加消息数量信息
        const infoDiv = document.createElement('div');
        infoDiv.style.cssText = `
            text-align: center;
            color: rgba(255, 255, 255, 0.6);
            margin-bottom: 15px;
            font-style: italic;
        `;
        infoDiv.textContent = `共 ${backup.chat.length} 条消息，仅显示最后 2 条`;
        msgContainer.appendChild(infoDiv);
        
        // 添加分隔线
        if (backup.chat.length > 2) {
            const divider = document.createElement('div');
            divider.style.cssText = `
                margin: 20px 0;
                height: 2px;
                background-color: rgba(255, 255, 255, 0.2);
                position: relative;
            `;
            
            const dividerText = document.createElement('div');
            dividerText.style.cssText = `
                position: absolute;
                top: -10px;
                left: 50%;
                transform: translateX(-50%);
                background-color: #121212;
                padding: 0 10px;
                color: rgba(255, 255, 255, 0.6);
            `;
            dividerText.textContent = '...';
            
            divider.appendChild(dividerText);
            msgContainer.appendChild(divider);
        }
        
        // 获取最后两条消息
        const lastMessages = backup.chat.slice(-2);
        
        // 尝试获取SillyTavern中的Markdown渲染函数
        let markdownRenderer = null;
        
        // 检查各种可能的Markdown渲染函数
        if (typeof window.renderMarkdown === 'function') {
            markdownRenderer = window.renderMarkdown;
        } else if (typeof window.backendMarkdownToHtml === 'function') {
            markdownRenderer = window.backendMarkdownToHtml;
        } else if (typeof window.markdown_converter !== 'undefined' && 
                  window.markdown_converter && 
                  typeof window.markdown_converter.makeHtml === 'function') {
            markdownRenderer = text => window.markdown_converter.makeHtml(text);
        }
        
        // 渲染消息
        lastMessages.forEach(msg => {
            // 过滤掉<think>和<thinking>标签内容
            let messageContent = msg.mes || '';
            messageContent = messageContent.replace(/<think>[\s\S]*?<\/think>/gi, '');
            messageContent = messageContent.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
            
            const messageDiv = document.createElement('div');
            messageDiv.style.cssText = `
                margin-bottom: 15px;
                padding: 10px;
                border-radius: 8px;
                background-color: ${msg.is_user ? 'rgba(0, 120, 255, 0.15)' : 'rgba(128, 0, 128, 0.15)'};
                color: rgba(255, 255, 255, 0.9);
            `;
            
            const nameDiv = document.createElement('div');
            nameDiv.style.cssText = `font-weight: bold; margin-bottom: 5px;`;
            nameDiv.textContent = msg.name || (msg.is_user ? '用户' : '助手');
            
            const contentDiv = document.createElement('div');
            contentDiv.style.cssText = `white-space: pre-wrap;`;
            
            // 使用Markdown渲染或简单格式化
            if (markdownRenderer) {
                contentDiv.innerHTML = markdownRenderer(messageContent);
            } else {
                // 简单格式化：处理换行符和基本Markdown
                messageContent = messageContent
                    .replace(/\n/g, '<br>')                         // 换行
                    .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')         // 粗体
                    .replace(/\*(.*?)\*/g, '<i>$1</i>')             // 斜体
                    .replace(/`(.*?)`/g, '<code>$1</code>')         // 行内代码
                    .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>'); // 代码块
                
                contentDiv.innerHTML = messageContent;
            }
            
            messageDiv.appendChild(nameDiv);
            messageDiv.appendChild(contentDiv);
            msgContainer.appendChild(messageDiv);
        });
        
        // 组装UI
        contentBox.appendChild(header);
        contentBox.appendChild(msgContainer);
        previewContainer.appendChild(contentBox);
        
        // 阻止事件冒泡
        contentBox.onclick = function(e) {
            e.stopPropagation();
        };
        
        // 添加关闭事件
        previewContainer.onclick = function(e) {
            if (e.target === previewContainer) {
                e.preventDefault();
                e.stopPropagation();
                document.body.removeChild(previewContainer);
            }
        };
        
        // 先移除可能已存在的预览窗口
        const existingPreview = document.getElementById('backup_preview_container');
        if (existingPreview) {
            document.body.removeChild(existingPreview);
        }
        
        // 添加到document.body
        document.body.appendChild(previewContainer);
        
    } catch (error) {
        console.error('[聊天自动备份] 预览备份失败:', error);
        toastr.error(`预览失败: ${error.message}`);
    }
}

// 在事件绑定部分添加预览按钮的点击事件处理
$(document).on('click', '.backup_preview_btn', function() {
    const button = $(this);
    const timestamp = parseInt(button.data('timestamp'));
    const chatKey = button.data('key');
    previewBackup(chatKey, timestamp);
});

// --- 初始化与事件绑定 ---
jQuery(async () => {
    console.log('[聊天自动备份] 插件加载中...');

    // 初始化设置
    const settings = initSettings();

    try {
        // 初始化数据库
        await initDatabase();

        // --- 创建 Web Worker ---
        try {
             // 定义 Worker 内部代码
            const workerCode = `
                // Worker Scope
                ${deepCopyLogicString} // 注入深拷贝函数

                self.onmessage = function(e) {
                    const { id, payload } = e.data;
                    // console.log('[Worker] Received message with ID:', id);
                    if (!payload) {
                         // console.error('[Worker] Invalid payload received');
                         self.postMessage({ id, error: 'Invalid payload received by worker' });
                         return;
                    }
                    try {
                        const copiedChat = payload.chat ? deepCopy(payload.chat) : null;
                        const copiedMetadata = payload.metadata ? deepCopy(payload.metadata) : null;
                        // console.log('[Worker] Deep copy successful for ID:', id);
                        self.postMessage({ id, result: { chat: copiedChat, metadata: copiedMetadata } });
                    } catch (error) {
                        // console.error('[Worker] Error during deep copy for ID:', id, error);
                        self.postMessage({ id, error: error.message || 'Worker deep copy failed' });
                    }
                };
            `;
            const blob = new Blob([workerCode], { type: 'application/javascript' });
            backupWorker = new Worker(URL.createObjectURL(blob));
            console.log('[聊天自动备份] Web Worker 已创建');

            // 设置 Worker 消息处理器 (主线程)
            backupWorker.onmessage = function(e) {
                const { id, result, error } = e.data;
                // logDebug(`[主线程] 从 Worker 收到消息 (ID: ${id})`);
                if (workerPromises[id]) {
                    if (error) {
                        console.error(`[主线程] Worker 返回错误 (ID: ${id}):`, error);
                        workerPromises[id].reject(new Error(error));
                    } else {
                        // logDebug(`[主线程] Worker 返回结果 (ID: ${id})`);
                        workerPromises[id].resolve(result);
                    }
                    delete workerPromises[id]; // 清理 Promise 记录
                } else {
                     console.warn(`[主线程] 收到未知或已处理的 Worker 消息 (ID: ${id})`);
                }
            };

            // 设置 Worker 错误处理器 (主线程)
            backupWorker.onerror = function(error) {
                console.error('[聊天自动备份] Web Worker 发生错误:', error);
                 // Reject any pending promises
                 Object.keys(workerPromises).forEach(id => {
                     workerPromises[id].reject(new Error('Worker encountered an unrecoverable error.'));
                     delete workerPromises[id];
                 });
                toastr.error('备份 Worker 发生错误，自动备份可能已停止', '聊天自动备份');
                 // 可以考虑在这里尝试重建 Worker
            };

        } catch (workerError) {
            console.error('[聊天自动备份] 创建 Web Worker 失败:', workerError);
            backupWorker = null; // 确保 worker 实例为空
            toastr.error('无法创建备份 Worker，将回退到主线程备份（性能较低）', '聊天自动备份');
            // 在这种情况下，performDeepCopyInWorker 需要一个回退机制（或插件应禁用/报错）
            // 暂时简化处理：如果Worker创建失败，备份功能将出错
        }

        // 加载插件UI
        const settingsHtml = await renderExtensionTemplateAsync(
            `third-party/${PLUGIN_NAME}`,
            'settings'
        );
        $('#extensions_settings').append(settingsHtml);
        console.log('[聊天自动备份] 已添加设置界面');

        // 设置控制项
        const $settingsBlock = $('<div class="chat_backup_control_item"></div>');
        $settingsBlock.html(`
            <div style="margin-bottom: 8px;">
                <label style="display: inline-block; min-width: 120px;">防抖延迟 (ms):</label>
                <input type="number" id="chat_backup_debounce_delay" value="${settings.backupDebounceDelay}" 
                    min="300" max="10000" step="100" title="编辑或删除消息后，等待多少毫秒再执行备份 (建议 1000-1500)" 
                    style="width: 80px;" />
            </div>
            <div>
                <label style="display: inline-block; min-width: 120px;">系统最大备份数:</label>
                <input type="number" id="chat_backup_max_total" value="${settings.maxTotalBackups}" 
                    min="1" max="10" step="1" title="系统中保留的最大备份数量" 
                    style="width: 80px;" />
            </div>
        `);
        $('.chat_backup_controls').prepend($settingsBlock);
        
        // 添加最大备份数设置监听
        $(document).on('input', '#chat_backup_max_total', function() {
            const total = parseInt($(this).val(), 10);
            if (!isNaN(total) && total >= 1 && total <= 10) {
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
        $(document).on('input', '#chat_backup_debounce_delay', function() {
            const delay = parseInt($(this).val(), 10);
            if (!isNaN(delay) && delay >= 300 && delay <= 10000) {
                settings.backupDebounceDelay = delay;
                logDebug(`防抖延迟已更新为: ${delay}ms`);
                saveSettingsDebounced();
            } else {
                logDebug(`无效的防抖延迟输入: ${$(this).val()}`);
                $(this).val(settings.backupDebounceDelay);
            }
        });

        // 恢复按钮
        $(document).on('click', '.backup_restore', async function() {
            const button = $(this);
            const timestamp = parseInt(button.data('timestamp'));
            const chatKey = button.data('key');
            logDebug(`点击恢复按钮, timestamp: ${timestamp}, chatKey: ${chatKey}`);

            button.prop('disabled', true).text('恢复中...'); // 禁用按钮并显示状态

            try {
                const db = await getDB();
                const backup = await new Promise((resolve, reject) => {
                    const transaction = db.transaction([STORE_NAME], 'readonly');
                    
                    transaction.onerror = (event) => {
                        reject(event.target.error);
                    };
                    
                    const store = transaction.objectStore(STORE_NAME);
                    const request = store.get([chatKey, timestamp]);
                    
                    request.onsuccess = () => {
                        resolve(request.result);
                    };
                    
                    request.onerror = (event) => {
                        reject(event.target.error);
                    };
                });

                if (backup) {
                    if (confirm(`确定要恢复 “${backup.entityName} - ${backup.chatName}” 的备份吗？\n\n这将选中对应的角色/群组，并创建一个【新的聊天】来恢复备份内容。\n\n当前聊天内容不会丢失，但请确保已保存。`)) {
                        const success = await restoreBackup(backup);
                        if (success) {
                            toastr.success('聊天记录已成功恢复到新聊天');
                        }
                    }
                } else {
                    console.error('[聊天自动备份] 找不到指定的备份:', { timestamp, chatKey });
                    toastr.error('找不到指定的备份');
                }
            } catch (error) {
                console.error('[聊天自动备份] 恢复过程中出错:', error);
                toastr.error(`恢复过程中出错: ${error.message}`);
            } finally {
                button.prop('disabled', false).text('恢复'); // 恢复按钮状态
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

        // 调试开关
        $(document).on('change', '#chat_backup_debug_toggle', function() {
            settings.debug = $(this).prop('checked');
            console.log('[聊天自动备份] 调试模式已' + (settings.debug ? '启用' : '禁用'));
            saveSettingsDebounced();
        });

        // 初始化UI状态 (延迟确保DOM渲染完毕)
        setTimeout(async () => {
            $('#chat_backup_debug_toggle').prop('checked', settings.debug);
            $('#chat_backup_debounce_delay').val(settings.backupDebounceDelay);
            $('#chat_backup_max_total').val(settings.maxTotalBackups);
            await updateBackupsList();
        }, 300);

        // --- 设置优化后的事件监听 ---
        function setupBackupEvents() {
            // 立即触发备份的事件 (状态明确结束)
            const immediateBackupEvents = [
                event_types.MESSAGE_SENT,           // 用户发送消息后
                event_types.GENERATION_ENDED,       // AI生成完成并添加消息后
                event_types.CHARACTER_FIRST_MESSAGE_SELECTED, // 选择角色第一条消息时                
            ].filter(Boolean); // 过滤掉可能不存在的事件类型

            // 触发防抖备份的事件 (编辑性操作)
            const debouncedBackupEvents = [
                event_types.MESSAGE_EDITED,        // 编辑消息后 (防抖)
                event_types.MESSAGE_DELETED,       // 删除消息后 (防抖)
                event_types.MESSAGE_SWIPED,         // 用户切换AI回复后 (防抖)
                event_types.IMAGE_SWIPED,           // 图片切换 (防抖)
                event_types.MESSAGE_FILE_EMBEDDED, // 文件嵌入 (防抖)
                event_types.MESSAGE_REASONING_EDITED, // 编辑推理 (防抖)
                event_types.MESSAGE_REASONING_DELETED, // 删除推理 (防抖)
                event_types.FILE_ATTACHMENT_DELETED, // 附件删除 (防抖)
                event_types.GROUP_UPDATED, //群组元数据更新 (防抖)
            ].filter(Boolean);

            console.log('[聊天自动备份] 设置立即备份事件监听:', immediateBackupEvents);
            immediateBackupEvents.forEach(eventType => {
                if (!eventType) {
                    console.warn('[聊天自动备份] 检测到未定义的立即备份事件类型');
                    return;
                }
                eventSource.on(eventType, () => {
                    logDebug(`事件触发 (立即备份): ${eventType}`);
                    // 使用新的条件备份函数
                    performBackupConditional().catch(error => {
                        console.error(`[聊天自动备份] 立即备份事件 ${eventType} 处理失败:`, error);
                    });
                });
            });

            console.log('[聊天自动备份] 设置防抖备份事件监听:', debouncedBackupEvents);
            debouncedBackupEvents.forEach(eventType => {
                if (!eventType) {
                    console.warn('[聊天自动备份] 检测到未定义的防抖备份事件类型');
                    return;
                }
                eventSource.on(eventType, () => {
                    logDebug(`事件触发 (防抖备份): ${eventType}`);
                    // 使用新的防抖备份函数
                    performBackupDebounced();
                });
            });

            console.log('[聊天自动备份] 事件监听器设置完成');
        }

        setupBackupEvents(); // 应用新的事件绑定逻辑

        // 监听扩展页面打开事件，刷新列表
        $(document).on('click', '#extensionsMenuButton', () => {
            if ($('#chat_auto_backup_settings').is(':visible')) {
                console.log('[聊天自动备份] 扩展菜单按钮点击，且本插件设置可见，刷新备份列表');
                setTimeout(updateBackupsList, 200); // 稍作延迟确保面板内容已加载
            }
        });

        // 抽屉打开时也刷新
        $(document).on('click', '#chat_auto_backup_settings .inline-drawer-toggle', function() {
            const drawer = $(this).closest('.inline-drawer');
            // 检查抽屉是否即将打开 (基于当前是否有 open class)
            if (!drawer.hasClass('open')) {
                console.log('[聊天自动备份] 插件设置抽屉打开，刷新备份列表');
                setTimeout(updateBackupsList, 50); // 几乎立即刷新
            }
        });

        // 初始备份检查 (延迟执行，确保聊天已加载)
        setTimeout(async () => {
            logDebug('[聊天自动备份] 执行初始备份检查');
            const context = getContext();
            if (context.chat && context.chat.length > 0 && !isBackupInProgress) {
                logDebug('[聊天自动备份] 发现现有聊天记录，执行初始备份');
                try {
                    await performBackupConditional(); // 使用条件函数
                } catch (error) {
                    console.error('[聊天自动备份] 初始备份执行失败:', error);
                }
            } else {
                logDebug('[聊天自动备份] 当前没有聊天记录或备份进行中，跳过初始备份');
            }
        }, 4000); // 稍长延迟，等待应用完全初始化

        console.log('[聊天自动备份] 插件加载完成');

    } catch (error) {
        console.error('[聊天自动备份] 插件加载过程中发生严重错误:', error);
        // 可以在UI上显示错误信息
        $('#extensions_settings').append(
            '<div class="error">聊天自动备份插件加载失败，请检查控制台。</div>'
        );
    }
});
