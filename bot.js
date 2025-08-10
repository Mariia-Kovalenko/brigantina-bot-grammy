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
import { InlineKeyboard } from "grammy";

// 1. Setup bot and session
const bot = new Bot(process.env.BOT_TOKEN);
bot.use(session({ initial: () => ({}) }));
bot.use(conversations());

// 2. Registration conversation
async function registrationConversation(conversation, ctx) {
    // Step 1: Select event
    const events = await getEvents();

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

async function sendStep(ctx, step) {
    if (step.options) {
        const keyboard = new InlineKeyboard();
        for (const option of step.options) {
            keyboard.text(option.text, option.callback_data).row();
        }
        await ctx.reply(step.prompt, { reply_markup: keyboard });
    } else {
        await ctx.reply(step.prompt);
    }
}

// Helper to build summary message
function buildSummary(reg) {
    let summary = "Перевірте ваші дані перед підтвердженням:\n";
    for (const [key, val] of Object.entries(reg.answers)) {
        summary += `${key.replace(/(_|\[.*?\])/g, ' ').trim()}: ${val}\n`;
    }
    return summary;
}

// Helper to restart registration
async function restartRegistration(ctx, reg) {
    reg.currentStep = 0;
    reg.answers = {};
    await sendStep(ctx, reg.steps[0]);
}

// Confirmation handler
bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    try {
        if (data.startsWith("event_")) {
            console.log('context', ctx.session);
            const eventId = data.split('_')[1];
            const event = await getCompetitionById(eventId);
            await ctx.answerCallbackQuery();
            await ctx.reply(event.info);
            const steps = await generateDynamicStep(event);

            ctx.session.registration = {
                eventId,
                steps,
                currentStep: 0,
                answers: {}
            };
            console.log('session', ctx.session);
            await sendStep(ctx, ctx.session.registration.steps[0]);
        } else if (data === "confirm_registration" && ctx.session.registration) {
            // User confirmed registration
            const reg = ctx.session.registration;
            const userState = {
                eventId: reg.eventId,
                steps: reg.steps,
                ...reg.answers
            };
            await ctx.answerCallbackQuery();
            try {
                const result = await saveRegistration(userState);
                console.log('result', result);
                await ctx.reply("Реєстрація успішна! Дякуємо!");
                ctx.session.registration = null;
            } catch (e) {
                console.error("Error in saveRegistration or sending success message:", e);
                await ctx.reply("Сталася помилка при збереженні реєстрації. Спробуйте ще раз або зверніться до адміністратора.");
            }
        } else if (data === "cancel_registration" && ctx.session.registration) {
            // User cancelled registration, restart
            const reg = ctx.session.registration;
            await ctx.answerCallbackQuery();
            await ctx.reply("Реєстрацію скасовано. Почнімо спочатку.");
            await restartRegistration(ctx, reg);
        } else if (ctx.session.registration) {
            // Handle option steps
            const reg = ctx.session.registration;
            const step = reg.steps[reg.currentStep];
            if (step && step.options) {
                const safeKey = step.title.replace(/\s+/g, '_');
                reg.answers[safeKey] = data;
                reg.currentStep++;
                if (reg.currentStep < reg.steps.length) {
                    await ctx.answerCallbackQuery();
                    await sendStep(ctx, reg.steps[reg.currentStep]);
                } else {
                    await ctx.answerCallbackQuery();
                    // Show summary and ask for confirmation
                    const summary = buildSummary(reg);
                    const keyboard = new InlineKeyboard()
                        .text("Підтвердити", "confirm_registration").row()
                        .text("Скасувати", "cancel_registration").row();
                    await ctx.reply(summary + "\nПідтвердити реєстрацію?", { reply_markup: keyboard });
                }
            }
        }
    } catch (error) {
        console.error('Error answering callback query:', error);
    }
});

async function generateDynamicStep(event) {
    const columns = await getEventColumns(event);
    const ageGroups = await getAgeGroups(event.id);
    const coaches = await getCoaches(event.id);
    const genders = ["жіноча", "чоловіча"];

    const steps = columns
            .filter(column => !column.includes('[payment]')) // Exclude [payment] columns from steps
            .map((column, index) => {
                const cleanTitle = column.replace(/\s*\[.*?\]\s*/g, '');
                let step = { step: index + 1, title: column, prompt: `Введіть ${cleanTitle}:` };

                if (column.includes("[age_groups]")) {
                    step.options = ageGroups.map(age => ({ text: age, callback_data: age }));
                } else if (column.includes("[coaches]")) {
                    step.options = coaches.map(coach => ({ text: coach.name, callback_data: coach.name }));
                } else if (column.includes("[gender]")) {
                    step.options = genders.map(gender => ({ text: gender, callback_data: gender }));
                } else if (column.includes("[boolean]")) {
                    step.options = [{ text: "Так", callback_data: "boolean_true" }, { text: "Ні", callback_data: "boolean_false" }];
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
    console.log(steps);
    return steps;
}

// 3. Register the conversation
bot.use(createConversation(registrationConversation));

// 4. Command to start registration
bot.command(COMMANDS.REGISTER, async (ctx) => {
    await ctx.conversation.enter("registrationConversation");
});

bot.command(COMMANDS.START, async (ctx) => {
    await ctx.reply("Welcome! Up and running.");
});

bot.command(COMMANDS.INFO, async (ctx) => {
    await ctx.reply(MESSAGES.INFO);
});

bot.command(COMMANDS.EVENTS, async (ctx) => {
    await ctx.reply(MESSAGES.EVENTS);
});

// Text handler for text steps
bot.on("message:text", async (ctx) => {
    const reg = ctx.session.registration;
    if (!reg) return; 

    const step = reg.steps[reg.currentStep];
    if (!step || step.options) return;

    const safeKey = step.title.replace(/\s+/g, '_');
    reg.answers[safeKey] = ctx.message.text;
    reg.currentStep++;

    if (reg.currentStep < reg.steps.length) {
        await sendStep(ctx, reg.steps[reg.currentStep]);
    } else {
        // Show summary and ask for confirmation
        const summary = buildSummary(reg);
        const keyboard = new InlineKeyboard()
            .text("Підтвердити", "confirm_registration").row()
            .text("Скасувати", "cancel_registration").row();
        await ctx.reply(summary + "\nПідтвердити реєстрацію?", { reply_markup: keyboard });
    }
});

// 5. Start the bot
bot.start();
