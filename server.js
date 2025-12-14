// server.js
import express from "express";
import http from "http";
import { Server } from "socket.io";
import dotenv from "dotenv";
import OpenAI from "openai";
import { pipeline, cos_sim } from '@xenova/transformers';
import { ABAY_SYSTEM_PROMPT, ABAY_KNOWLEDGE_CHUNKS } from "./consts.js";
import sqlite3 from 'sqlite3';
import path from 'path';
import { promisify } from 'util';

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.static("public"));

// ==================== SQLite Setup ====================
const dbPath = path.join(process.cwd(), 'db.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Ошибка подключения к БД:', err.message);
    } else {
        console.log('БД подключена: db.sqlite');
        initDB();
    }
});

const dbGetAsync = promisify(db.get.bind(db));
const dbAllAsync = promisify(db.all.bind(db));

function dbRunAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

function initDB() {
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
        db.run(`CREATE TABLE IF NOT EXISTS conversations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            title TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users (id)
        )`);
        db.run(`CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id INTEGER,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE
        )`);
        db.run('CREATE INDEX IF NOT EXISTS idx_user_conv ON conversations(user_id)');
        db.run('CREATE INDEX IF NOT EXISTS idx_conv_msg ON messages(conversation_id)');
    });
}

// ==================== FAQ ====================
const faq = {
    bio: {
        canonical: ["биография абая", "кто такой абай", "абай кунанбаев"],
        response: "Я — Абай Кунанбаев (1845–1904), великий казахский поэт и просветитель из Семипалатинской области. Родился 10 августа в Чингисских горах в семье бия Кунанбая (1804–1886) и Улжан; дед Оскенбай, прадед Иргизбай — знатный род. Учился у муллы и русских учителей, боролся за просвещение народа. Мои 'Слова назидания' учат этике и знаниям: 'Человек без знания — как дерево без корней'."
    },
    family: {
        canonical: ["семья абая", "жены абая", "дети абая", "жена абая"],
        response: "Моя семья — из рода биев: отец Кунанбай (влиятельный бий, твердый и щедрый), мать Улжан. Три жены по обычаю: первая Дильда (династический брак, родила 6 детей), Айгерим и Еркежан. Дети: 7 сыновей и 2 дочери (многие умерли рано), старший Акылбай (1861–1904, воспитывался у Нурганым — жены отца), Магауия (Магаш), Камал, Турагай и т.д. Семья научила ценить гармонию: 'Семья — корень жизни, без него ветви сохнут'."
    },
    friends: {
        canonical: ["друзья абая", "шәкәрім", "кокбай", "михаэлис"],
        response: "Я дружил с Кокпаем Джантасовым в юности (приписывал ему первые стихи), русскими интеллигентами — Н.Д. Бухертом (учителем), Г.Н. Потаниным, П.И. Бронзовым, Е.П. Михаэлисом; казахами — Шакаримом Кудайбердиевым (племянник), Якыпом, Ашпасом, Уайсом (защищали от конфликтов). Дружба формировала просвещение: 'Истинный друг — зеркало души, отражающее свет знаний'."
    }
};

// ==================== Эмбеддинги ====================
let embedder = null;
let faqEmbeddings = {};
let knowledgeEmbeddings = [];
let embeddingsReady = false;

(async () => {
    try {
        console.log("Загрузка модели эмбеддингов (Xenova/all-MiniLM-L6-v2)...");
        embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');

        for (const [topic, data] of Object.entries(faq)) {
            faqEmbeddings[topic] = await Promise.all(
                data.canonical.map(async (text) =>
                    (await embedder(text.toLowerCase(), { pooling: 'mean', normalize: true })).data
                )
            );
        }

        console.log("Генерация эмбеддингов для базы знаний Абая...");
        knowledgeEmbeddings = await Promise.all(
            ABAY_KNOWLEDGE_CHUNKS.map(async (chunk) =>
                (await embedder(chunk.toLowerCase(), { pooling: 'mean', normalize: true })).data
            )
        );

        embeddingsReady = true;
        console.log("Все эмбеддинги готовы. RAG активен.");
    } catch (err) {
        console.error("Ошибка загрузки эмбеддингов:", err.message);
    }
})();

// FAQ матч
async function findBestFAQMatch(question) {
    if (!embeddingsReady || !embedder) return null;

    const q = question.toLowerCase().trim();

    const complexPatterns = [
        "период", "год", "когда", "в каком", "в какие", "время", "эпоха",
        "сложно", "трудно", "тяжело", "легко", "жизнь была", "жилось",
        "умер", "смерть", "родился", "год рождения", "возраст", "сколько лет",
        "было ли", "почему", "за что", "как он", "что с ним", "а если", "а что"
    ];

    const isComplex = complexPatterns.some(pattern => q.includes(pattern)) ||
        q.split(/\s+/).length > 9 ||
        /[?!]{2,}/.test(q) ||
        q.includes("абай") && q.length > 35;

    if (isComplex) return null;

    const qEmb = (await embedder(q, { pooling: 'mean', normalize: true })).data;

    let bestScore = 0;
    let bestTopic = null;

    for (const [topic, embeddings] of Object.entries(faqEmbeddings)) {
        for (const emb of embeddings) {
            const score = cos_sim(qEmb, emb);
            if (score > bestScore) {
                bestScore = score;
                bestTopic = topic;
            }
        }
    }

    if (bestScore >= 0.78) {
        console.log(`FAQ match → ${bestTopic} (score: ${bestScore.toFixed(3)})`);
        return faq[bestTopic].response;
    }

    return null;
}

// RAG поиск
async function retrieveRelevantChunks(question, topK = 5, minScore = 0.52) {
    if (!embeddingsReady || !embedder || knowledgeEmbeddings.length === 0) return [];

    const q = question.toLowerCase().trim();
    const qEmb = (await embedder(q, { pooling: 'mean', normalize: true })).data;

    const similarities = knowledgeEmbeddings.map((emb, idx) => ({
        index: idx,
        score: cos_sim(qEmb, emb)
    }));

    similarities.sort((a, b) => b.score - a.score);

    return similarities
        .slice(0, topK)
        .filter(s => s.score >= minScore)
        .map(s => ABAY_KNOWLEDGE_CHUNKS[s.index]);
}

// ==================== Основная логика ответа (с памятью!) ====================
async function askAbay(question, conversationId, lang = 'ru') {
    const q = question.trim();
    if (!q) return "";

    // 1. FAQ — быстрый точный ответ
    const faqReply = await findBestFAQMatch(q);
    if (faqReply) {
        return faqReply;
    }

    // 2. RAG контекст
    const relevantChunks = await retrieveRelevantChunks(q);
    let ragContext = "";
    if (relevantChunks.length > 0) {
        ragContext = `ОБЯЗАТЕЛЬНО используй ТОЛЬКО эти факты для ответа (без вымысла):\n\n${relevantChunks.join("\n\n")}`;
        console.log(`RAG: передано ${relevantChunks.length} чанков в контекст`);
    } else {
        ragContext = "Отвечай мудро, опираясь на просветительские идеи и 'Слова назидания'.";
    }

    // 3. Язык
    let langSpecificPrompt = ABAY_SYSTEM_PROMPT;
    if (lang === 'kk') {
        langSpecificPrompt = ABAY_SYSTEM_PROMPT.replace('Отвечай исключительно на русском языке', 'Отвечай исключительно на казахском языке (кириллица)');
    }

    const systemPrompt = `${langSpecificPrompt}\n\nКонтекст для точного ответа:\n${ragContext}`;

    // 4. Загружаем историю чата (последние 20 сообщений)
    let history = [];
    try {
        const rows = await dbAllAsync(
            "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC LIMIT 20",
            [conversationId]
        );
        history = rows.map(row => ({
            role: row.role === 'user' ? 'user' : 'assistant',
            content: row.content
        }));
    } catch (err) {
        console.error("Ошибка загрузки истории:", err);
    }

    // Добавляем текущий вопрос
    history.push({ role: "user", content: q });

    try {
        const response = await client.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: systemPrompt },
                ...history
            ],
            max_tokens: 1000,
            temperature: 0.7
        }, { timeout: 20000 });

        return response.choices[0].message.content.trim();
    } catch (err) {
        console.error("OpenAI error:", err.message);
        return lang === 'kk'
            ? "Кешір, досым, қазір мәңгілік туралы ой үстіндемін… Кейін сұра."
            : "Прости, друг, сейчас я в глубинах размышлений о вечном… Спроси ещё раз чуть позже.";
    }
}

// ==================== Socket.IO ====================
io.on("connection", (socket) => {
    const userId = socket.handshake.query.userId;
    let userLang = 'ru';

    socket.on('set-language', (lang) => {
        if (['ru', 'kk'].includes(lang)) {
            userLang = lang;
            console.log(`Язык пользователя ${userId}: ${lang}`);
        }
    });

    console.log("Подключение:", socket.id, "User:", userId);

    db.get("SELECT id FROM users WHERE id = ?", [userId], (err, row) => {
        if (err) console.error(err);
        if (!row) db.run("INSERT INTO users (id) VALUES (?)", [userId]);
    });

    async function loadConversations() {
        try {
            const rows = await dbAllAsync("SELECT id, title, created_at, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC", [userId]);
            socket.emit("load-conversations", rows || []);
        } catch (err) {
            console.error(err);
        }
    }

    let currentConvId = null;

    async function loadCurrentConversation() {
        try {
            const conv = await dbGetAsync("SELECT id FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1", [userId]);
            currentConvId = conv ? conv.id : null;
            if (currentConvId) {
                await loadConversationById(currentConvId);
            } else {
                await createNewConversation("Новый чат с Абаем");
            }
        } catch (err) {
            console.error(err);
        }
    }

    async function loadConversationById(convId) {
        try {
            const msgs = await dbAllAsync("SELECT role, content, timestamp FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC", [convId]);
            socket.emit("load-chat", { convId, messages: msgs || [], isNew: false });
        } catch (err) {
            console.error(err);
        }
    }

    async function createNewConversation(title = "Новый чат с Абаем") {
        try {
            const result = await dbRunAsync("INSERT INTO conversations (user_id, title) VALUES (?, ?)", [userId, title]);
            const newConvId = result.lastID;
            socket.emit("new-conversation", { convId: newConvId, title, isNew: true });
            await loadConversations();
            await loadConversationById(newConvId);
        } catch (err) {
            console.error(err);
        }
    }

    loadCurrentConversation();
    loadConversations();

    socket.on("new-conversation", async ({ title }) => {
        const newTitle = title?.trim() || "Новый чат с Абаем";
        await createNewConversation(newTitle);
    });

    socket.on("message", async (data) => {
        const { text, convId } = data;
        if (!text.trim() || !convId) return;

        try {
            const row = await dbGetAsync("SELECT id FROM conversations WHERE id = ?", [convId]);
            if (!row) {
                socket.emit("chat-invalid", { message: "Чат удалён. Переключаемся..." });
                await loadCurrentConversation();
                return;
            }

            await dbRunAsync("INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', ?)", [convId, text]);

            socket.emit("bot-typing", true);

            const reply = await askAbay(text, convId, userLang); // ← передаём convId для истории!

            await dbRunAsync("INSERT INTO messages (conversation_id, role, content) VALUES (?, 'bot', ?)", [convId, reply]);
            await dbRunAsync("UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", [convId]);

            socket.emit("bot-typing", false);
            socket.emit("bot-message", { from: "abay", text: reply, convId });

            // НЕ вызываем loadConversations() — чтобы не анимировать список заново
        } catch (err) {
            console.error(err);
            socket.emit("bot-typing", false);
            socket.emit("bot-message", { from: "abay", text: "Ошибка. Попробуй ещё.", convId });
        }
    });

    socket.on("switch-conversation", async (convId) => {
        const row = await dbGetAsync("SELECT id FROM conversations WHERE id = ?", [convId]);
        if (row) {
            currentConvId = convId;
            await loadConversationById(convId);
        } else {
            socket.emit("chat-invalid", { message: "Чат не найден." });
            await loadCurrentConversation();
        }
    });

    socket.on("rename-conversation", async ({ convId, newTitle }) => {
        try {
            await dbRunAsync("UPDATE conversations SET title = ? WHERE id = ?", [newTitle, convId]);
            await loadConversations();
        } catch (err) {
            console.error(err);
        }
    });

    socket.on("delete-conversation", async (convId) => {
        try {
            const countRow = await dbGetAsync("SELECT COUNT(*) as count FROM conversations WHERE user_id = ?", [userId]);
            if (countRow && countRow.count > 1) {
                await dbRunAsync("DELETE FROM conversations WHERE id = ?", [convId]);
                await loadConversations();
                socket.emit("chat-deleted", { convId });
                if (currentConvId === convId) {
                    await loadCurrentConversation();
                }
            } else {
                socket.emit("delete-failed", { reason: "Нельзя удалить единственный чат." });
            }
        } catch (err) {
            console.error(err);
        }
    });

    socket.on("disconnect", () => console.log("Отключился:", socket.id));
});

process.on('unhandledRejection', (err) => {
    console.error('Необработанная ошибка:', err);
});

server.listen(3000, () => {
    console.log("Абай-бот запущен → http://localhost:3000");
    console.log("RAG + Память чата + Русский/Казахский");
    console.log("Ожидаю мудрых вопросов...");
});