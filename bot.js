import { Bot, session } from "grammy";
import { conversations, createConversation } from "@grammyjs/conversations";
import {
    getEvents,
    getCompetitionById,
    getEventColumns,
    getAgeGroups,
    getCoaches,
    saveRegistration,
    getMerchProducts,
    getCategoryBanners,
    saveMerchOrdersSimple
} from "./spreadsheets/spreadsheets.js";
import { COMMANDS, MESSAGES } from "./utils/constants.js";
import { InlineKeyboard, Keyboard } from "grammy";
import http from "http";
import { getUpcomingEvents } from "./utils/helpers.js";

// Simple in-memory caches for merch
const PRODUCT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let productCache = { items: [], fetchedAt: 0 };
const productImageFileIdCache = new Map(); // productId -> file_id

async function getProductsCached() {
    const now = Date.now();
    if (productCache.items.length && now - productCache.fetchedAt < PRODUCT_CACHE_TTL_MS) {
        return productCache.items;
    }
    const items = await getMerchProducts();
    productCache = { items, fetchedAt: now };
    return items;
}

// Global cached category banners (name -> image URL), refreshed periodically
let CATEGORY_BANNERS_CACHE = {};
async function refreshCategoryBanners() {
    try {
        CATEGORY_BANNERS_CACHE = await getCategoryBanners();
        console.log("Cached category banners:", Object.keys(CATEGORY_BANNERS_CACHE).length);
    } catch (e) {
        console.error("Failed to refresh category banners:", e);
    }
}
// Prime cache and refresh every 15 minutes
refreshCategoryBanners();
setInterval(refreshCategoryBanners, 15 * 60 * 1000);

// 1. Setup bot and session
const bot = new Bot(process.env.BOT_TOKEN);
bot.use(session({ initial: () => ({}) }));
bot.use(conversations());

// 2. Registration conversation
async function registrationConversation(conversation, ctx) {
    // Step 1: Select event
    let events = await getEvents();
    // filter events by date if today is before event date
    events = getUpcomingEvents(events);

    if (events.length === 0) {
        await ctx.reply("Наразі немає доступних заходів. Спробуйте пізніше.");
        return;
    }

    if (events.length === 0) {
        await ctx.reply("Наразі немає доступних заходів. Спробуйте пізніше.");
        return;
    }

    // Create a vertical inline keyboard (one button per row)
    const keyboard = new InlineKeyboard();
    for (const event of events) {
        keyboard.text(event.name, `event_${event.id}`).row();
    }

    // Send inline keyboard with message.
    await ctx.reply(MESSAGES.EVENTS, {
        reply_markup: keyboard,
    });
}

// Events conversation: send all upcoming events with short info, then exit
async function eventsConversation(conversation, ctx) {
    try {
        let events = await getEvents();
        events = getUpcomingEvents(events);
        if (!events || events.length === 0) {
            await ctx.reply("Наразі немає доступних заходів. Спробуйте пізніше.");
            return;
        }
        // Build message with name and info per event
        let message = "Ось перелік найближчих заходів:\n\n";
        for (const ev of events) {
            const info = (ev.info || "").replace(/\\n/g, "\n");
            message += `🔹 ${ev.name}\n ℹ️ ${info}\n\n`;
        }
        // Telegram has a 4096 char limit; send in chunks if needed
        const MAX = 3500;
        for (let i = 0; i < message.length; i += MAX) {
            await ctx.reply(message.slice(i, i + MAX));
        }
    } catch (e) {
        console.error("Error in eventsConversation:", e);
        await ctx.reply("Сталася помилка під час завантаження заходів. Спробуйте пізніше.");
    }
}

// Merch conversation: browse categories and products with a pseudo-cart
async function merchConversation(conversation, ctx) {
    // ensure session and cart exist
    ctx.session = ctx.session || {};
    if (!ctx.session.merchCart) ctx.session.merchCart = [];
    if (typeof ctx.session.merchOrderLockTs !== "number") ctx.session.merchOrderLockTs = 0;
    let currentCategory = null;
    let checkout = { name: "", phone: "" };

    // Prefetch products and categories for this conversation from cache
    const products = await getProductsCached();
    const categoriesList = Array.from(new Set(products.map(p => (p.category || "").trim()).filter(Boolean)));

    async function showCategories(c = ctx) {
        const categories = categoriesList;
        if (!categories || !categories.length) {
            await c.reply("Категорії мерчу поки відсутні.");
            return null;
        }
        const allBanner = CATEGORY_BANNERS_CACHE["Усі товари"]; // optional global banner
        if (allBanner) {
            try { await c.replyWithPhoto(allBanner, { caption: "Категорії мерчу" }); } catch {}
        }
        const kb = new InlineKeyboard();
        for (const cName of categories) kb.text(cName, `merch_cat_${cName}`).row();
        kb.text("🛒 Кошик", "merch_cart").row();
        kb.text("Закрити", "merch_close").row();
        await c.reply("Оберіть категорію:", { reply_markup: kb });
        return categories;
    }

    async function showProductList(category, c = ctx) {
        currentCategory = String(category || "").trim();
        const items = products.filter((p) => (p.category || "").trim() === currentCategory);
        if (!items.length) {
            await c.reply("У цій категорії товарів немає.");
            return;
        }
        const kb = new InlineKeyboard();
        for (const item of items) {
            kb.text(item.name, `merch_prod_${item.id}`).row();
        }
        kb.text("⬅️ До категорій", "merch_back").row();
        kb.text("🛒 Кошик", "merch_cart").row();
        kb.text("Закрити", "merch_close").row();
        await c.reply(`Оберіть товар у категорії: ${currentCategory}`, { reply_markup: kb });
    }

    async function showProductCard(productId, c = ctx) {
        const item = products.find((p) => String(p.id) === String(productId));
        if (!item) {
            await c.reply("Цей товар наразі недоступний.");
            return;
        }
        const caption = `<b>${item.name}</b>\n` +
            (item.description ? `${item.description}\n` : "") +
            (item.color ? `Колір: ${item.color}\n` : "") +
            `Ціна: ${item.price} грн\nВ наявності: ${item.stock}`;
        const kb = new InlineKeyboard()
            .text("➕ Додати до кошика", `merch_add_${item.id}`).row()
            .text("⬅️ Назад до товарів", "merch_products_back").row()
            .text("⬅️ До категорій", "merch_back").row()
            .text("🛒 Кошик", "merch_cart").row();
        try {
            const cachedFileId = productImageFileIdCache.get(String(item.id));
            if (cachedFileId) {
                await c.replyWithPhoto(cachedFileId, { caption, parse_mode: "HTML", reply_markup: kb });
            } else if (item.image) {
                const msg = await c.replyWithPhoto(item.image, { caption, parse_mode: "HTML", reply_markup: kb });
                const photos = msg?.photo || [];
                const best = photos[photos.length - 1];
                if (best?.file_id) {
                    productImageFileIdCache.set(String(item.id), best.file_id);
                }
            } else {
                await c.reply(caption, { parse_mode: "HTML", reply_markup: kb });
            }
        } catch {
            await c.reply(caption, { parse_mode: "HTML", reply_markup: kb });
        }
    }

    function addToCartById(productId, productsList) {
        const item = productsList.find((p) => String(p.id) === String(productId));
        if (!item) return false;
        // find existing
        const existing = (ctx.session.merchCart || []).find((i) => i.id === String(item.id));
        if (existing) {
            existing.quantity += 1;
        } else {
            ctx.session.merchCart.push({ id: String(item.id), name: item.name, price: item.price, quantity: 1, color: item.color || "" });
        }
        return true;
    }

    async function showCart(c = ctx) {
        const cart = (ctx.session && ctx.session.merchCart) ? ctx.session.merchCart : [];
        if (!cart.length) {
            await c.reply("Кошик порожній.");
            return;
        }
        let text = "🛒 Ваш кошик:\n\n";
        let total = 0;
        for (const it of cart) {
            const line = `${it.name}${it.color ? ` (${it.color})` : ""} × ${it.quantity} = ${it.price * it.quantity} грн`;
            text += `• ${line}\n`;
            total += it.price * it.quantity;
        }
        text += `\nРазом: <b>${total} грн</b>`;
        const summaryKb = new InlineKeyboard()
            .text("Оформити замовлення", "merch_checkout").row()
            .text("Очистити", "merch_cart_clear").row()
            .text("⬅️ До категорій", "merch_back").row()
            .text("Закрити", "merch_close").row();
        await c.reply(text, { parse_mode: "HTML", reply_markup: summaryKb });

        // Per-item controls
        for (const it of cart) {
            const line = `${it.name}${it.color ? ` (${it.color})` : ""} — кількість: ${it.quantity}`;
            const kb = new InlineKeyboard()
                .text("−", `cart_dec_${it.id}`).text("+", `cart_inc_${it.id}`).text("❌", `cart_rm_${it.id}`).row();
            await c.reply(line, { reply_markup: kb });
        }
    }

    async function askCustomerName() {
        await ctx.reply("Вкажіть, будь ласка, ваше ПІБ:");
        const m = await conversation.waitFor("message:text");
        checkout.name = m.message.text.trim();
    }

    async function askCustomerPhone() {
        await ctx.reply("Вкажіть, будь ласка, ваш номер телефону:");
        const m = await conversation.waitFor("message:text");
        checkout.phone = m.message.text.trim();
    }

    async function confirmOrder(c = ctx) {
        const cart = ctx.session.merchCart || [];
        let summary = `Підтвердження замовлення:\nЗамовник: ${checkout.name}\nТелефон: ${checkout.phone}\n\n`;
        let total = 0;
        for (const it of cart) {
            summary += `• ${it.name}${it.color ? ` (${it.color})` : ""} × ${it.quantity} = ${it.price * it.quantity} грн\n`;
            total += it.price * it.quantity;
        }
        summary += `\nРазом: <b>${total} грн</b>\nПідтвердити замовлення?`;
        const kb = new InlineKeyboard()
            .text("Підтвердити", "merch_order_confirm").row()
            .text("Скасувати", "merch_order_cancel").row();
        await c.reply(summary, { parse_mode: "HTML", reply_markup: kb });
    }

    await showCategories();
    while (true) {
        // Wait specifically for callback data updates
        const cb = await conversation.waitFor("callback_query:data");
        const data = cb.callbackQuery?.data || "";

        if (data === "merch_close") {
            await cb.answerCallbackQuery();
            await cb.reply("Дякуємо за інтерес до мерчу!");
            return; // exit conversation
        }
        if (data === "merch_back") {
            await cb.answerCallbackQuery();
            await showCategories(cb);
            continue;
        }
        if (data === "merch_products_back") {
            await cb.answerCallbackQuery();
            if (currentCategory) await showProductList(currentCategory, cb);
            else await showCategories(cb);
            continue;
        }
        if (data === "merch_cart") {
            await cb.answerCallbackQuery();
            await showCart(cb);
            continue;
        }
        if (data === "merch_cart_clear") {
            await cb.answerCallbackQuery();
            ctx.session = ctx.session || {};
            ctx.session.merchCart = [];
            await cb.reply("Кошик очищено.");
            await showCategories(cb);
            continue;
        }
        if (data.startsWith("cart_inc_")) {
            await cb.answerCallbackQuery();
            const id = data.replace("cart_inc_", "");
            const cart = ctx.session.merchCart || [];
            const item = cart.find(x => String(x.id) === String(id));
            if (item) item.quantity += 1;
            await cb.reply("Оновлено кількість (+1)");
            await showCart(cb);
            continue;
        }
        if (data.startsWith("cart_dec_")) {
            await cb.answerCallbackQuery();
            const id = data.replace("cart_dec_", "");
            const cart = ctx.session.merchCart || [];
            const item = cart.find(x => String(x.id) === String(id));
            if (item) {
                item.quantity = Math.max(0, item.quantity - 1);
                if (item.quantity === 0) {
                    ctx.session.merchCart = cart.filter(x => String(x.id) !== String(id));
                }
            }
            await cb.reply("Оновлено кількість (−1)");
            await showCart(cb);
            continue;
        }
        if (data.startsWith("cart_rm_")) {
            await cb.answerCallbackQuery();
            const id = data.replace("cart_rm_", "");
            const cart = ctx.session.merchCart || [];
            ctx.session.merchCart = cart.filter(x => String(x.id) !== String(id));
            await cb.reply("Товар видалено з кошика");
            if ((ctx.session.merchCart || []).length === 0) {
                await cb.reply("Кошик порожній.");
                await showCategories(cb);
            } else {
                await showCart(cb);
            }
            continue;
        }
        if (data === "merch_checkout") {
            await cb.answerCallbackQuery();
            await askCustomerName();
            await askCustomerPhone();
            await confirmOrder(cb);
            continue;
        }
        if (data === "merch_order_cancel") {
            await cb.answerCallbackQuery();
            await cb.reply("Замовлення скасовано.");
            await showCart(cb);
            continue;
        }
        if (data === "merch_order_confirm") {
            await cb.answerCallbackQuery({ text: "Обробляємо замовлення…" });
            // Prevent duplicate confirmations within 15 seconds
            const now = Date.now();
            if (now - (ctx.session.merchOrderLockTs || 0) < 15000) {
                await cb.reply("Замовлення вже обробляється. Зачекайте, будь ласка.");
                continue;
            }
            ctx.session.merchOrderLockTs = now;
            const cart = ctx.session.merchCart || [];
            if (!cart.length) {
                await cb.reply("Кошик порожній.");
                ctx.session.merchOrderLockTs = 0;
                return; // end conversation after successful order
            }
            const rows = cart.map(it => ({
                date: new Date().toLocaleString("uk-UA"),
                product: it.name,
                color: it.color || "",
                qty: it.quantity,
                customer: checkout.name,
                phone: checkout.phone,
            }));
            try {
                await saveMerchOrdersSimple(rows);
                await cb.reply("Замовлення прийнято! Ми зв'яжемося з вами для підтвердження.");
                ctx.session.merchCart = [];
                ctx.session.merchOrderLockTs = 0;
                return; // end conversation after successful order
            } catch (e) {
                console.error("Error saving merch order:", e);
                await cb.reply("Не вдалося зберегти замовлення. Спробуйте пізніше.");
                ctx.session.merchOrderLockTs = 0;
                return; // end conversation on error as well
            }
        }
        if (data.startsWith("merch_cat_")) {
            const category = data.replace("merch_cat_", "").trim();
            await cb.answerCallbackQuery();
            const banner = CATEGORY_BANNERS_CACHE[category];
            if (banner) {
                try { await cb.replyWithPhoto(banner, { caption: `Категорія: ${category}` }); } catch {}
            }
            await showProductList(category, cb);
            continue;
        }
        if (data.startsWith("merch_prod_")) {
            const id = data.replace("merch_prod_", "");
            await cb.answerCallbackQuery();
            await showProductCard(id, cb);
            continue;
        }
        if (data.startsWith("merch_add_")) {
            const id = data.replace("merch_add_", "");
            const ok = addToCartById(id, products);
            try {
                await cb.answerCallbackQuery({ text: ok ? "Додано до кошика" : "Товар недоступний" });
            } catch {}
            continue;
        }

        // Unknown clicks: just clear loader safely
        try { await cb.answerCallbackQuery(); } catch {}
    }
}

// Helper to build multi-select keyboard for coaches
function buildMultiSelectKeyboard(options, selected, callbackPrefix) {
    const keyboard = new InlineKeyboard();
    for (const option of options) {
        const isSelected = selected.includes(option.text);
        const label = (isSelected ? "✅ " : "◽️ ") + option.text;
        keyboard.text(label, `${callbackPrefix}_${option.text}`).row();
    }
    keyboard.text("Готово", `${callbackPrefix}_done`).row();
    return keyboard;
}

// Update sendStep to support multi-select for coaches
async function sendStep(ctx, step, reg) {
    if (step.options) {
        if (step.title.includes("[coaches]")) {
            const coachesKey = step.title.replace(/\s+/g, "_");
            const selected = reg?.answers[coachesKey] || [];
            const keyboard = buildMultiSelectKeyboard(
                step.options,
                selected,
                "coach"
            );
            await ctx.reply(step.prompt, { reply_markup: keyboard });
        } else {
            const keyboard = new InlineKeyboard();
            for (const option of step.options) {
                keyboard.text(option.text, option.callback_data).row();
            }
            await ctx.reply(step.prompt, { reply_markup: keyboard });
        }
    } else {
        await ctx.reply(step.prompt);
    }
}

// Helper to build summary message
function buildSummary(reg) {
    let summary = `‼️Перевірте ваші дані перед підтвердженням:\n 📍Ви обрали захід: ${reg.eventName}\n📝Дані учасника:\n`;
    for (const [key, val] of Object.entries(reg.answers)) {
        summary += `🔹${key.replace(/(_|\[.*?\])/g, " ").trim()}: ${val}\n`;
    }
    return summary;
}

// Helper to restart registration
async function restartRegistration(ctx, reg) {
    reg.currentStep = 0;
    reg.answers = {};
    await sendStep(ctx, reg.steps[0], reg);
}

// Confirmation handler
bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data || "";
    const reg = ctx.session.registration;
    try {
        if (data.startsWith("event_")) {
            const eventId = data.split("_")[1];
            const event = await getCompetitionById(eventId);
            await ctx.answerCallbackQuery();
            await ctx.reply(event.info);
            const steps = await generateDynamicStep(event);

            ctx.session.registration = {
                eventId,
                eventName: event.name,
                steps,
                currentStep: 0,
                answers: {},
            };
            await sendStep(
                ctx,
                ctx.session.registration.steps[0],
                ctx.session.registration
            );
            return;
        }
        if (data === "confirm_registration" && reg) {
            const userState = {
                eventId: reg.eventId,
                steps: reg.steps,
                ...reg.answers,
            };
            await ctx.answerCallbackQuery();
            try {
                for (const key in userState) {
                    if (key != 'steps' && Array.isArray(userState[key])) {
                        userState[key] = userState[key].join(", ");
                    }
                }
                await saveRegistration(userState);
                await ctx.reply("Реєстрація успішна! Дякуємо!");
                ctx.session.registration = null;
            } catch (e) {
                console.error(
                    "Error in saveRegistration or sending success message:",
                    e
                );
                await ctx.reply(
                    "Сталася помилка при збереженні реєстрації. Спробуйте ще раз або зверніться до адміністратора."
                );
            }
            return;
        }
        if (data === "cancel_registration" && reg) {
            ctx.session.registration = null;
            await ctx.answerCallbackQuery();
            await ctx.reply("Реєстрацію скасовано. Ви можете почати реєстрацію знову у будь-який час.");
            return;
        }
        if (data === "retry_registration" && reg) {
            await ctx.answerCallbackQuery();
            await ctx.reply("Починаємо реєстрацію спочатку.");
            await restartRegistration(ctx, reg);
            return;
        }
        if (reg) {
            const step = reg.steps[reg.currentStep];
            if (step && step.options) {
                const safeKey = step.title.replace(/\s+/g, "_");
                if (step.title.includes("[coaches]")) {
                    if (!reg.answers[safeKey]) reg.answers[safeKey] = [];
                    if (data.startsWith("coach_")) {
                        const coachName = data.replace("coach_", "");
                        if (coachName === "done") {
                            reg.currentStep++;
                            if (reg.currentStep < reg.steps.length) {
                                await ctx.answerCallbackQuery();
                                await sendStep(
                                    ctx,
                                    reg.steps[reg.currentStep],
                                    reg
                                );
                            } else {
                                await ctx.answerCallbackQuery();
                                const summary = buildSummary(reg);
                                const keyboard = new InlineKeyboard()
                                    .text("Підтвердити", "confirm_registration")
                                    .row()
                                    .text("Почати заново", "retry_registration")
                                    .row()
                                    .text("Скасувати", "cancel_registration")
                                    .row();
                                await ctx.reply(
                                    summary + "\nПідтвердити реєстрацію?",
                                    { reply_markup: keyboard }
                                );
                            }
                        } else {
                            const idx = reg.answers[safeKey].indexOf(coachName);
                            if (idx === -1) {
                                reg.answers[safeKey].push(coachName);
                            } else {
                                reg.answers[safeKey].splice(idx, 1);
                            }
                            await ctx.answerCallbackQuery();
                            const keyboard = buildMultiSelectKeyboard(
                                step.options,
                                reg.answers[safeKey],
                                "coach"
                            );
                            await ctx.editMessageReplyMarkup({
                                reply_markup: keyboard,
                            });
                        }
                        return;
                    }
                } else {
                    reg.answers[safeKey] = data;
                    reg.currentStep++;
                    if (reg.currentStep < reg.steps.length) {
                        await ctx.answerCallbackQuery();
                        await sendStep(ctx, reg.steps[reg.currentStep], reg);
                    } else {
                        await ctx.answerCallbackQuery();
                        const summary = buildSummary(reg);
                        const keyboard = new InlineKeyboard()
                            .text("Підтвердити", "confirm_registration")
                            .row()
                            .text("Скасувати", "cancel_registration")
                            .row();
                        await ctx.reply(summary + "\nПідтвердити реєстрацію?", {
                            reply_markup: keyboard,
                        });
                    }
                    return;
                }
            }
        }
        // Not handled here: let other middlewares (e.g., merch conversation) handle
        await next();
    } catch (error) {
        console.error("Error answering callback query:", error);
        // If error, still allow next middlewares to try
        try { await next(); } catch {}
    }
});

async function generateDynamicStep(event) {
    const columns = await getEventColumns(event);
    const ageGroups = await getAgeGroups(event.id);
    const coaches = await getCoaches(event.id);
    const genders = ["жіноча", "чоловіча"];

    const steps = columns
        .filter((column) => !column.includes("[payment]")) // Exclude [payment] columns from steps
        .map((column, index) => {
            const cleanTitle = column.replace(/\s*\[.*?\]\s*/g, "");
            let step = {
                step: index + 1,
                title: column,
                prompt: `Введіть ${cleanTitle}:`,
            };

            if (column.includes("[age_groups]")) {
                step.options = ageGroups.map((age) => ({
                    text: age,
                    callback_data: age,
                }));
            } else if (column.includes("[coaches]")) {
                step.options = coaches.map((coach) => ({
                    text: coach.name,
                    callback_data: coach.name,
                }));
            } else if (column.includes("[gender]")) {
                step.options = genders.map((gender) => ({
                    text: gender,
                    callback_data: gender,
                }));
            } else if (column.includes("[boolean]")) {
                step.options = [
                    { text: "Так", callback_data: "boolean_true" },
                    { text: "Ні", callback_data: "boolean_false" },
                ];
            }
            // Mark conditional steps
            if (column.includes("[conditional]")) {
                step.isConditional = true;
            }

            if (step.options) {
                step.prompt = `Оберіть ${cleanTitle}:`;
            }
            return step;
        });
    return steps;
}

// 3. Register the conversation
bot.use(createConversation(registrationConversation));
bot.use(createConversation(eventsConversation));
bot.use(createConversation(merchConversation));

// 4. Command to start registration
bot.command(COMMANDS.REGISTER, async (ctx) => {
    await ctx.conversation.enter("registrationConversation");
});

// Build main menu keyboard
const mainMenu = new Keyboard()
    .text("Інформація").row()
    .text("Переглянути змагання").row()
    .text("Реєстрація на змагання").row()
    .text("Допомога").resized();

bot.command(COMMANDS.START, async (ctx) => {
    await ctx.reply(MESSAGES.START, { reply_markup: mainMenu });
});

bot.command(COMMANDS.INFO, async (ctx) => {
    await ctx.reply(MESSAGES.INFO);
});

bot.command(COMMANDS.EVENTS, async (ctx) => {
    await ctx.conversation.enter("eventsConversation");
});
bot.command("merch", async (ctx) => {
    await ctx.conversation.enter("merchConversation");
});
bot.command(COMMANDS.HELP, async (ctx) => {
    await ctx.reply(MESSAGES.HELP);
});

// Menu button handlers (mimic commands)
bot.hears("Інформація", async (ctx) => {
    await ctx.reply(MESSAGES.INFO);
});

bot.hears("Переглянути змагання", async (ctx) => {
    await ctx.conversation.enter("eventsConversation");
});

bot.hears("Реєстрація на змагання", async (ctx) => {
    await ctx.conversation.enter("registrationConversation");
});

bot.hears("Допомога", async (ctx) => {
    await ctx.reply("Доступні команди:\n/start — головне меню\n/info — інформація\n/events — переглянути змагання\n/register — реєстрація на змагання");
});

// Text handler for text steps
bot.on("message:text", async (ctx) => {
    const reg = ctx.session.registration;
    if (!reg) return;

    const step = reg.steps[reg.currentStep];
    if (!step || step.options) return;

    const safeKey = step.title.replace(/\s+/g, "_");
    reg.answers[safeKey] = ctx.message.text;
    reg.currentStep++;

    if (reg.currentStep < reg.steps.length) {
        await sendStep(ctx, reg.steps[reg.currentStep], reg);
    } else {
        // Show summary and ask for confirmation
        const summary = buildSummary(reg);
        const keyboard = new InlineKeyboard()
            .text("Підтвердити", "confirm_registration")
            .row()
            .text("Скасувати", "cancel_registration")
            .row();
        await ctx.reply(summary + "\nПідтвердити реєстрацію?", {
            reply_markup: keyboard,
        });
    }
});

// 5. Start the bot
bot.start();

// Minimal HTTP server for Render port binding / health checks
const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
  })
  .listen(PORT, () => {
    console.log("HTTP server listening on", PORT);
  });
