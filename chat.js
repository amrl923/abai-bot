// chat.js
const socket = io({ query: { userId: getUserId() } });

const messages = document.getElementById("messages");
const input = document.getElementById("inputText");
const btn = document.getElementById("sendBtn");
const typingIndicator = document.getElementById("typing-indicator");
const conversationsList = document.getElementById("conversationsList");
const newChatBtn = document.getElementById("newChatBtn");
const hamburgerBtn = document.getElementById("hamburgerBtn");
const sidebar = document.querySelector(".sidebar");
const sidebarOverlay = document.getElementById("sidebar-overlay");
const mainChat = document.querySelector(".main-chat");
const settingsBtn = document.getElementById("settingsBtn");
const settingsPanel = document.querySelector(".settings-panel");
const settingsOverlay = document.getElementById("settings-overlay");
const closeSettingsBtn = document.getElementById("closeSettingsBtn");
const inputContainer = document.querySelector(".input-container");

let currentConvId = null;
let conversations = [];
let typingTimeout = null;
let deletePending = new Set();
let currentTab = 'chats';

// Theme management
function initTheme() {
    const savedTheme = localStorage.getItem('abayTheme') || 'light';
    toggleTheme(savedTheme);
}

function toggleTheme(theme) {
    const isDark = theme === 'dark';
    document.body.classList.toggle('dark', isDark);
    localStorage.setItem('abayTheme', theme);
    updateThemeButtons(isDark);
}

function updateThemeButtons(isDark) {
    document.querySelectorAll('.theme-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.theme === (isDark ? 'dark' : 'light'));
    });
}

// Language management
let currentLang = 'ru';

function initLanguage() {
    currentLang = localStorage.getItem('abayLang') || 'ru';
    applyLanguage(currentLang);
    updateLanguageButtons(currentLang);
}

function applyLanguage(lang) {
    currentLang = lang;
    const t = window.I18N[lang];

    document.querySelectorAll('.tab-btn').forEach(btn => {
        const tab = btn.dataset.tab;
        btn.textContent = t.tabs[tab];
    });

    document.querySelectorAll('.content-header h2').forEach(h2 => {
        const content = h2.closest('.tab-content');
        if (content) {
            const tab = content.id.replace('-content', '');
            if (t.tabs[tab]) h2.textContent = t.tabs[tab];
        }
    });

    document.getElementById('newChatBtn').textContent = t.newChat;

    const noChats = document.querySelector('.no-chats');
    if (noChats) noChats.textContent = t.noChats;

    document.querySelector('.settings-header h2').textContent = t.settings;
    document.querySelectorAll('.setting-label').forEach((label, i) => {
        label.textContent = i === 0 ? t.language : t.theme;
    });

    document.querySelectorAll('.theme-btn').forEach(btn => {
        btn.textContent = t[btn.dataset.theme];
    });

    document.querySelectorAll('.lang-btn').forEach(btn => {
        btn.textContent = btn.dataset.lang === 'ru' ? 'Русский' : 'Қазақша';
    });

    input.placeholder = t.inputPlaceholder;

    const typingText = document.querySelector('.typing-content span:first-child');
    if (typingText) typingText.textContent = t.abayTyping;

    socket.emit('set-language', lang);
}

function setLanguage(lang) {
    localStorage.setItem('abayLang', lang);
    updateLanguageButtons(lang);
    applyLanguage(lang);
}

function updateLanguageButtons(lang) {
    document.querySelectorAll('.lang-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.lang === lang);
    });
}

// Settings
function toggleSettings() {
    settingsPanel.classList.toggle('open');
    settingsOverlay.classList.toggle('open');
}

function closeSettings() {
    settingsPanel.classList.remove('open');
    settingsOverlay.classList.remove('open');
}

// Sidebar
function toggleSidebar() {
    if (currentTab === 'chats' || currentTab === 'quizzes') {
        sidebar.classList.toggle('open');
        sidebarOverlay.classList.toggle('open');
    }
}

function closeSidebar() {
    sidebar.classList.remove('open');
    sidebarOverlay.classList.remove('open');
}

// User ID
function getUserId() {
    let userId = localStorage.getItem('abayUserId');
    if (!userId) {
        userId = crypto.randomUUID?.() || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            const r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
        localStorage.setItem('abayUserId', userId);
    }
    return userId;
}

// Input control
function disableInput() {
    input.disabled = true;
    btn.disabled = true;
    input.style.opacity = "0.5";
    btn.style.opacity = "0.5";
}

function enableInput() {
    input.disabled = false;
    btn.disabled = false;
    input.style.opacity = "1";
    btn.style.opacity = "1";
    input.placeholder = window.I18N[currentLang].inputPlaceholder;
}

// Add message + auto scroll
function addMessage(text, who, animate = true) {
    const div = document.createElement("div");
    div.className = `msg ${who}`;

    const avatar = document.createElement("div");
    avatar.className = `avatar ${who}`;
    avatar.innerHTML = who === "user" ? "👤" : "🤖";

    const content = document.createElement("div");
    content.className = "content";
    content.innerText = text;

    div.appendChild(avatar);
    div.appendChild(content);
    messages.appendChild(div);

    // Автоскролл в конец
    messages.scrollTop = messages.scrollHeight;

    if (animate) {
        div.style.opacity = "0";
        div.style.transform = "translateY(10px)";
        setTimeout(() => {
            div.style.transition = "all 0.3s ease";
            div.style.opacity = "1";
            div.style.transform = "translateY(0)";
        }, 10);
    }
}

// Load chat
function loadChat(convId, msgs, isNew = false) {
    messages.innerHTML = "";
    typingIndicator.classList.add('hidden');
    currentConvId = convId;

    msgs.forEach(msg => addMessage(msg.content, msg.role === 'user' ? 'user' : 'bot', false));

    if (msgs.length === 0 && !isNew) {
        addMessage("Здравствуйте! Задавайте вопросы про Абая Кунанбаева, и я отвечу мудро.", "bot", false);
    }

    // Подсветка активного чата
    document.querySelectorAll('.conversations-list li').forEach(li => li.classList.remove('active'));
    const activeLi = conversationsList.querySelector(`[data-id="${convId}"]`)?.closest('li');
    if (activeLi) activeLi.classList.add('active');
}

// Render conversations (без лишней анимации при обновлении)
function renderConversations(convs) {
    conversations = convs.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)); // на всякий
    conversationsList.innerHTML = '';

    if (convs.length === 0) {
        const li = document.createElement('li');
        li.className = 'no-chats';
        li.textContent = window.I18N[currentLang]?.noChats || 'Нет чатов. Создайте первый!';
        conversationsList.appendChild(li);
        return;
    }

    const isOnlyOne = convs.length === 1;

    convs.forEach(conv => {
        const li = document.createElement('li');
        li.innerHTML = `
            <div class="conv-header">
                <div class="conv-title">${conv.title}</div>
                <div class="conv-actions">
                    <button class="action-btn rename-btn" data-id="${conv.id}" title="Переименовать">✏️</button>
                    <button class="action-btn delete-btn" data-id="${conv.id}" ${isOnlyOne ? 'disabled' : ''} title="Удалить">🗑️</button>
                </div>
            </div>
            <div class="conv-date">${new Date(conv.updated_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}</div>
        `;

        if (conv.id === currentConvId) li.classList.add('active');

        li.addEventListener('click', (e) => {
            if (!e.target.closest('.action-btn')) {
                switchConversation(conv.id);
                closeSidebar();
            }
        });

        conversationsList.appendChild(li);
    });
}

// Switch conversation
function switchConversation(convId) {
    socket.emit("switch-conversation", convId);
}

// Tab switching
function switchTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelector(`.tab-btn[data-tab="${tab}"]`).classList.add('active');

    currentTab = tab;

    const needsSidebar = tab === 'chats' || tab === 'quizzes';

    if (needsSidebar) {
        sidebar.classList.remove('hidden');
        document.querySelectorAll('.sidebar .tab-content').forEach(content => content.classList.remove('active'));
        document.getElementById(`${tab}-content`).classList.add('active');
        hamburgerBtn.classList.remove('hidden-mobile');
    } else {
        sidebar.classList.add('hidden');
        hamburgerBtn.classList.add('hidden-mobile');
        messages.innerHTML = "";
        typingIndicator.classList.add('hidden');
        currentConvId = null;
        enableInput();
        input.disabled = true;
        btn.disabled = true;
        input.placeholder = "Скоро здесь будет контент...";
    }

    if (tab === 'chats') {
        inputContainer.classList.remove('hidden');
        enableInput();

        if (!currentConvId && conversations.length > 0) {
            const latest = conversations[0];
            switchConversation(latest.id);
        }
    } else {
        inputContainer.classList.add('hidden');
    }
}

// Events
btn.onclick = send;
input.onkeydown = (e) => {
    if (e.key === "Enter" && !input.disabled && currentConvId && currentTab === 'chats') send();
};

newChatBtn.onclick = () => {
    const title = prompt('Название нового чата:', 'Новый чат с Абаем');
    if (title && title.trim()) {
        socket.emit("new-conversation", { title: title.trim() });
        closeSidebar();
    }
};

hamburgerBtn.onclick = toggleSidebar;
sidebarOverlay.onclick = closeSidebar;

settingsBtn.onclick = toggleSettings;
closeSettingsBtn.onclick = closeSettings;
settingsOverlay.onclick = closeSettings;

document.querySelectorAll('.lang-btn').forEach(btn => btn.addEventListener('click', () => setLanguage(btn.dataset.lang)));
document.querySelectorAll('.theme-btn').forEach(btn => btn.addEventListener('click', () => toggleTheme(btn.dataset.theme)));
document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

function send() {
    if (input.disabled || !currentConvId || currentTab !== 'chats') return;

    const text = input.value.trim();
    if (!text) return;

    addMessage(text, "user");
    socket.emit("message", { text, convId: currentConvId });

    input.value = "";
    disableInput();

    typingTimeout = setTimeout(() => {
        typingIndicator.classList.add('hidden');
        enableInput();
        addMessage("Хм, задержка... Попробуй позже.", "bot");
    }, 15000);
}

// Actions in list
conversationsList.addEventListener('click', (e) => {
    if (e.target.classList.contains('rename-btn')) {
        const convId = e.target.dataset.id;
        const conv = conversations.find(c => c.id == convId);
        const newTitle = prompt('Новое название:', conv?.title || '');
        if (newTitle && newTitle.trim()) {
            socket.emit("rename-conversation", { convId, newTitle: newTitle.trim() });
        }
    } else if (e.target.classList.contains('delete-btn') && !e.target.disabled) {
        const convId = e.target.dataset.id;
        if (confirm('Удалить чат? Все сообщения потеряются.')) {
            socket.emit("delete-conversation", convId);
        }
    }
});

// Socket events
socket.on("bot-message", (data) => {
    addMessage(data.text, "bot");
    enableInput();
    if (typingTimeout) clearTimeout(typingTimeout);
});

socket.on("bot-typing", (isTyping) => {
    typingIndicator.classList.toggle('hidden', !isTyping);
    if (isTyping) disableInput();
    else enableInput();
});

socket.on("load-conversations", renderConversations);

socket.on("load-chat", ({ convId, messages: msgs, isNew }) => {
    loadChat(convId, msgs, isNew);
});

socket.on("new-conversation", ({ convId, title }) => {
    // Сервер уже отправит load-conversations, но можно обновить локально
    if (currentTab === 'chats') {
        switchConversation(convId);
    }
});

socket.on("chat-deleted", ({ convId }) => {
    // Ключевой фикс: если удалённый чат был открыт — очистить и переключиться
    if (currentConvId == convId) {
        messages.innerHTML = "";
        typingIndicator.classList.add('hidden');
        currentConvId = null;

        // Переключаемся на самый свежий оставшийся чат
        const remaining = conversations.filter(c => c.id != convId);
        if (remaining.length > 0) {
            const latest = remaining.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))[0];
            switchConversation(latest.id);
        } else {
            addMessage("Все чаты удалены. Создайте новый.", "bot");
        }
    }
    deletePending.delete(convId);
});

socket.on("delete-failed", ({ reason }) => {
    alert(reason);
});

socket.on("chat-invalid", () => {
    // Автопереключение на последний
    if (conversations.length > 0) {
        const latest = conversations[0];
        switchConversation(latest.id);
    }
});

// Input focus — плавный скролл на мобильных
input.addEventListener('focus', () => {
    setTimeout(() => {
        messages.scrollTop = messages.scrollHeight;
    }, 300);
});

// Init
document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    initLanguage();
    switchTab('chats');
});

socket.on('connect', () => {
    console.log("Подключен к Абай-боту");
});