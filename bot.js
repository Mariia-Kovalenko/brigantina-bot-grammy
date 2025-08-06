import { Bot } from "grammy";
import dotenv from "dotenv";
import { COMMANDS, MESSAGES } from "./utils/constants.js";
import { getEvents } from "./spreadsheets/spreadsheets.js";

dotenv.config();

const bot = new Bot(process.env.BOT_TOKEN);

bot.command("start", (ctx) => ctx.reply(MESSAGES.START));
bot.command("info", (ctx) => ctx.reply(MESSAGES.INFO));


bot.command("events", async (ctx) => {
    const events = await getEvents();
    const eventsList = events.map((event) => `${event.id} - ${event.name}`).join("\n");
    ctx.reply(MESSAGES.EVENTS + "\n" + eventsList);
});

bot.command("register", (ctx) => ctx.reply(MESSAGES.REGISTER));
bot.command("help", (ctx) => ctx.reply(MESSAGES.HELP));

bot.on("message", (ctx) => ctx.reply("Got another message!"));
// Start the bot.
bot.start();