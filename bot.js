const { Telegraf } = require('telegraf');
const OpenAI = require('openai');

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);

const client = new OpenAI({
  apiKey: process.env.API_KEY,
  baseURL: process.env.BASE_URL || 'https://api.openai.com/v1'
});

const ALLOWED_USERS = []; // nanti diisi user id lo

bot.on('text', async (ctx) => {
  if (ALLOWED_USERS.length > 0 && !ALLOWED_USERS.includes(ctx.from.id)) {
    return;
  }

  try {
    const response = await client.chat.completions.create({
      model: process.env.MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Kamu asisten yang jujur dan langsung.' },
        { role: 'user', content: ctx.message.text }
      ]
    });

    await ctx.reply(response.choices[0].message.content);
  } catch (error) {
    await ctx.reply('Error: ' + error.message);
  }
});

bot.launch();
console.log('Bot sudah jalan');
