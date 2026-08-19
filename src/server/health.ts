import express from "express";
import type { Bot } from "grammy";

export function startHealthServer(bot: Bot) {
  const app = express();
  const port = process.env.PORT || 3000;

  app.get("/health", (_req, res) => {
    const botInfo = bot.botInfo;
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      bot: botInfo ? { username: botInfo.username, id: botInfo.id } : null,
      uptime: process.uptime(),
    });
  });

  app.get("/", (_req, res) => {
    res.json({ status: "running", service: "base-auto-mint-bot" });
  });

  app.listen(port, () => {
    console.log(`✅ Health check server listening on port ${port}`);
  });

  return app;
}
