import { Bot, session } from "grammy";
import { conversations, createConversation } from "@grammyjs/conversations";
import {
    getEvents,
    getCompetitionById,
    getEventColumns,
    getAgeGroups,
    getCoaches,
    saveRegistration,
} from "./spreadsheets/spreadsheets.js";
import { COMMANDS, MESSAGES } from "./utils/constants.js";
import { InlineKeyboard, Keyboard } from "grammy";
import http from "http";
import { getUpcomingEvents } from "./utils/helpers.js";

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
bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
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
        } else if (
            data === "confirm_registration" &&
            ctx.session.registration
        ) {
            // User confirmed registration
            const userState = {
                eventId: reg.eventId,
                steps: reg.steps,
                ...reg.answers,
            };
            await ctx.answerCallbackQuery();
            try {
                // Convert arrays to strings for Google Sheets
                for (const key in userState) {
                    if (key != 'steps' && Array.isArray(userState[key])) {
                        userState[key] = userState[key].join(", ");
                    }
                }
                const result = await saveRegistration(userState);
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
        } else if (data === "cancel_registration" && ctx.session.registration) {
            // User cancelled registration, exit
            ctx.session.registration = null;
            await ctx.answerCallbackQuery();
            await ctx.reply("Реєстрацію скасовано. Ви можете почати реєстрацію знову у будь-який час.");
        } else if (data === "retry_registration" && ctx.session.registration) {
            // User wants to retry registration, restart
            const reg = ctx.session.registration;
            await ctx.answerCallbackQuery();
            await ctx.reply("Починаємо реєстрацію спочатку.");
            await restartRegistration(ctx, reg);
        } else if (reg) {
            // Handle option steps
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
                            // Toggle selection
                            const idx = reg.answers[safeKey].indexOf(coachName);
                            if (idx === -1) {
                                reg.answers[safeKey].push(coachName);
                            } else {
                                reg.answers[safeKey].splice(idx, 1);
                            }
                            await ctx.answerCallbackQuery();
                            // Rebuild and edit the keyboard to reflect selection
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
                }
            }
        }
    } catch (error) {
        console.error("Error answering callback query:", error);
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
    await ctx.reply("Welcome! Up and running.", { reply_markup: mainMenu });
});

bot.command(COMMANDS.INFO, async (ctx) => {
    await ctx.reply(MESSAGES.INFO);
});

bot.command(COMMANDS.EVENTS, async (ctx) => {
    await ctx.reply(MESSAGES.EVENTS);
});
bot.command(COMMANDS.HELP, async (ctx) => {
    await ctx.reply(MESSAGES.HELP);
});

// Menu button handlers (mimic commands)
bot.hears("Інформація", async (ctx) => {
    await ctx.reply(MESSAGES.INFO);
});

bot.hears("Переглянути змагання", async (ctx) => {
    await ctx.reply(MESSAGES.EVENTS);
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
