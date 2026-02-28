import "dotenv/config";
import { Markup, Telegraf } from "telegraf";
import { getLink, getStats, listDomains, listLinks, shortenUrl } from "./services/shortenerApi.js";
import { listRules, normalizeDomain, removeRule, upsertRule } from "./services/rulesStore.js";
import { isDmVerified, setDmVerified, upsertUser } from "./services/usersStore.js";
import { extractUrls, pickMatchedUrl } from "./utils/urlMatch.js";

const botToken = process.env.BOT_TOKEN;
const apiKey = process.env.SHORTNER_API_KEY;

if (!botToken) throw new Error("BOT_TOKEN missing in .env");
if (!apiKey) throw new Error("SHORTNER_API_KEY missing in .env");

const bot = new Telegraf(botToken);
const userCooldown = new Map();
const recentUrlInChat = new Map();
const COOLDOWN_MS = 5000;
const DUPLICATE_WINDOW_MS = 45000;
const MAX_EXPIRES_MINUTES = 10080;
const REQUIRED_CHANNEL = process.env.REQUIRED_CHANNEL || "@BINBHAII";
const MAKER_LINK = "https://t.me/callmeshooter";
const GROUP_POLICY_CACHE_MS = 120000;
const groupPolicyCache = new Map();
const verifiedDmUsers = new Set();
const dmJoinPromptCooldown = new Map();
const JOIN_PROMPT_COOLDOWN_MS = 15 * 1000;
let botInfoCache;

function isGroup(ctx) {
  return ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
}

async function isAdmin(ctx) {
  if (!isGroup(ctx)) return true;
  const userId = ctx.from?.id;
  if (!userId) return false;
  const member = await ctx.telegram.getChatMember(ctx.chat.id, userId);
  return member.status === "creator" || member.status === "administrator";
}

function usageText() {
  return [
    "<b>Commands</b>",
    "• <code>/autourl &lt;domain&gt; &lt;yes|no&gt; exp=20</code>",
    "• <code>/listautourl</code>",
    "• <code>/removeautourl &lt;domain&gt;</code>",
    "• <code>/short &lt;url&gt; alias=name exp=20 domain=id</code>",
    "• <code>/mylinks [search]</code>",
    "• <code>/linkinfo &lt;linkId&gt;</code>",
    "• <code>/stats &lt;linkId&gt; [days]</code>",
    "• <code>/domains</code>",
    "",
    "<b>Auto mode</b>",
    "• <b>yes</b>: delete original matched message",
    "• <b>no</b>: keep original and reply with short URL",
    `• <b>exp</b>: 1-${MAX_EXPIRES_MINUTES} minutes`,
    "",
  ].join("\n");
}

function uiKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Help", "ui_help"), Markup.button.callback("Rules", "ui_rules")],
    [Markup.button.callback("Domains", "ui_domains"), Markup.button.callback("My Links", "ui_mylinks")]
  ]);
}

function panel(title, bodyLines) {
  return `<b>${title}</b>\n${bodyLines.join("\n")}\n\n<i>Hii How Are You!! <a href="${MAKER_LINK}"></a></i>`;
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function renderPanelInPlace(ctx, title, bodyLines, extra = {}) {
  const text = panel(title, bodyLines);
  try {
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...uiKeyboard(),
      ...extra
    });
  } catch {
    await ctx.reply(text, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...uiKeyboard(),
      ...extra
    });
  }
}

function channelLink(handle) {
  const clean = String(handle || "").replace(/^@/, "");
  return `https://t.me/${clean}`;
}

async function getBotInfo(ctx) {
  if (!botInfoCache) botInfoCache = await ctx.telegram.getMe();
  return botInfoCache;
}

function isMemberStatus(member) {
  if (!member?.status) return false;
  if (member.status === "restricted") return member.is_member === true;
  return ["creator", "administrator", "member"].includes(member.status);
}

async function isChannelJoined(ctx, userId) {
  if (!userId) return false;
  try {
    const member = await ctx.telegram.getChatMember(REQUIRED_CHANNEL, userId);
    return isMemberStatus(member);
  } catch {
    return null;
  }
}

async function ensureDmJoinPolicy(ctx) {
  if (ctx.chat?.type !== "private") return true;
  const userId = ctx.from?.id;
  const now = Date.now();
  if (verifiedDmUsers.has(userId)) {
    const joined = await isChannelJoined(ctx, userId);
    if (joined === false) {
      verifiedDmUsers.delete(userId);
      await setDmVerified(userId, false);
    } else {
      return true;
    }
  } else {
    const dbVerified = await isDmVerified(userId);
    if (dbVerified) {
      verifiedDmUsers.add(userId);
      const joined = await isChannelJoined(ctx, userId);
      if (joined === false) {
        verifiedDmUsers.delete(userId);
        await setDmVerified(userId, false);
      } else {
        return true;
      }
    }
  }

  const joined = await isChannelJoined(ctx, userId);
  if (joined === true) {
    verifiedDmUsers.add(userId);
    await setDmVerified(userId, true);
    return true;
  }
  if (joined === null) return true;

  const lastPromptAt = dmJoinPromptCooldown.get(userId) || 0;
  if (now - lastPromptAt < JOIN_PROMPT_COOLDOWN_MS) return false;
  dmJoinPromptCooldown.set(userId, now);
  await ctx.reply(
    panel("Join Required", [
      `To use this bot in DM, join <b>${esc(REQUIRED_CHANNEL)}</b> first.`,
      "After joining, send /start again."
    ]),
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.url(`Join ${REQUIRED_CHANNEL}`, channelLink(REQUIRED_CHANNEL))],
        [Markup.button.callback("Verify", "verify_join")]
      ])
    }
  );
  return false;
}

async function ensureGroupPolicy(ctx) {
  if (!isGroup(ctx)) return true;
  const chatId = ctx.chat.id;
  const now = Date.now();
  const cached = groupPolicyCache.get(chatId);
  if (cached && now - cached.time < GROUP_POLICY_CACHE_MS) return cached.ok;
  try {
    const botInfo = await getBotInfo(ctx);
    const botMember = await ctx.telegram.getChatMember(chatId, botInfo.id);
    if (!["administrator", "creator"].includes(botMember.status)) {
      await ctx.reply("Bot must be admin in this group.");
      groupPolicyCache.set(chatId, { ok: false, time: now });
      return false;
    }
    const admins = await ctx.telegram.getChatAdministrators(chatId);
    const owner = admins.find((a) => a.status === "creator")?.user;
    if (!owner?.id) {
      await ctx.reply("Cannot verify group owner. Try again.");
      groupPolicyCache.set(chatId, { ok: false, time: now });
      return false;
    }
    const ownerJoined = await isChannelJoined(ctx, owner.id);
    if (ownerJoined === false) {
      await ctx.reply(`Group owner must join ${REQUIRED_CHANNEL} first.`);
      groupPolicyCache.set(chatId, { ok: false, time: now });
      return false;
    }
    groupPolicyCache.set(chatId, { ok: true, time: now });
    return true;
  } catch {
    await ctx.reply("Policy check failed. Ensure bot has admin permission.");
    groupPolicyCache.set(chatId, { ok: false, time: now });
    return false;
  }
}

function parseCommandOptions(parts) {
  const opts = {};
  for (const token of parts) {
    const [k, ...rest] = token.split("=");
    if (!k || !rest.length) continue;
    opts[k.toLowerCase()] = rest.join("=");
  }
  return opts;
}

function normalizeLinkList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.links)) return payload.links;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.results)) return payload.results;
  return [];
}

function parseExpiresMinutes(value) {
  if (value === undefined || value === null || value === "") return null;
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_EXPIRES_MINUTES) {
    return null;
  }
  return minutes;
}

bot.use(async (ctx, next) => {
  try {
    await upsertUser(ctx.from, ctx.chat);
  } catch {}
  await next();
});

bot.start(async (ctx) => {
  if (!(await ensureDmJoinPolicy(ctx))) return;
  if (!(await ensureGroupPolicy(ctx))) return;
  await ctx.reply(
    panel("LinkShortner Bot", [
      "Clean short links for your group.",
      "",
      "Use buttons or /help to get started."
    ]),
    {
      parse_mode: "HTML",
      ...uiKeyboard()
    }
  );
});

bot.help(async (ctx) => {
  if (!(await ensureDmJoinPolicy(ctx))) return;
  if (!(await ensureGroupPolicy(ctx))) return;
  await ctx.reply(usageText(), { parse_mode: "HTML", ...uiKeyboard() });
});

bot.action("ui_help", async (ctx) => {
  await ctx.answerCbQuery();
  if (!(await ensureDmJoinPolicy(ctx))) return;
  if (!(await ensureGroupPolicy(ctx))) return;
  await renderPanelInPlace(ctx, "Help", usageText().split("\n"));
});

bot.action("ui_rules", async (ctx) => {
  await ctx.answerCbQuery();
  if (!(await ensureDmJoinPolicy(ctx))) return;
  if (!(await ensureGroupPolicy(ctx))) return;
  if (!isGroup(ctx)) {
    await renderPanelInPlace(ctx, "Auto Rules", ["Open this in your group and run /listautourl"]);
    return;
  }
  const rules = await listRules(ctx.chat.id);
  if (!rules.length) {
    await renderPanelInPlace(ctx, "Auto Rules", ["No rules set in this group yet."]);
    return;
  }
  const lines = rules.map(
    (r) =>
      `• <code>${esc(r.domain)}</code> — <b>${r.deleteOriginal ? "yes" : "no"}</b>${r.expiresIn ? `, ${r.expiresIn}m` : ""}`
  );
  await renderPanelInPlace(ctx, "Auto Rules", lines);
});

bot.action("ui_domains", async (ctx) => {
  await ctx.answerCbQuery();
  if (!(await ensureDmJoinPolicy(ctx))) return;
  if (!(await ensureGroupPolicy(ctx))) return;
  try {
    const data = await listDomains();
    const domains = Array.isArray(data) ? data : data?.domains || data?.items || [];
    if (!domains.length) {
      await renderPanelInPlace(ctx, "Domains", ["No domains found."]);
      return;
    }
    const list = domains
      .slice(0, 20)
      .map((d) => `• <code>${esc(d.domain || d.host || d.name || d)}</code>`)
      .join("\n");
    await renderPanelInPlace(ctx, "Domains", [list]);
  } catch (error) {
    await renderPanelInPlace(ctx, "Domains", [`Domains failed: ${esc(error?.message || "unknown error")}`]);
  }
});

bot.action("ui_mylinks", async (ctx) => {
  await ctx.answerCbQuery();
  if (!(await ensureDmJoinPolicy(ctx))) return;
  if (!(await ensureGroupPolicy(ctx))) return;
  try {
    const data = await listLinks({ page: 1, limit: 10, active: true });
    const links = normalizeLinkList(data);
    if (!links.length) {
      await renderPanelInPlace(ctx, "My Links", ["No links found."]);
      return;
    }
    const rows = links.slice(0, 10).map((l) => {
      const id = l.id || l.linkId || "n/a";
      const shortUrl = l.shortUrl || l.shortURL || l.url || "n/a";
      const originalUrl = l.originalUrl || l.targetUrl || "";
      return `<code>${esc(id)}</code>\n<code>${esc(shortUrl)}</code>\n${esc(originalUrl)}`;
    });
    await renderPanelInPlace(ctx, "My Latest Links", rows);
  } catch (error) {
    await renderPanelInPlace(ctx, "My Links", [`List failed: ${esc(error?.message || "unknown error")}`]);
  }
});

bot.action("verify_join", async (ctx) => {
  await ctx.answerCbQuery("Checking...");
  const userId = ctx.from?.id;
  const joined = await isChannelJoined(ctx, userId);
  if (joined !== true) {
    await renderPanelInPlace(ctx, "Join Required", [
      `To use this bot in DM, join <b>${esc(REQUIRED_CHANNEL)}</b> first.`,
      "After joining, tap Verify again."
    ]);
    return;
  }
  verifiedDmUsers.add(userId);
  await setDmVerified(userId, true);
  await renderPanelInPlace(ctx, "Verified", ["Access granted.", "Use /help to see all commands."]);
});

bot.command("autourl", async (ctx) => {
  if (!(await ensureGroupPolicy(ctx))) return;
  if (!isGroup(ctx)) {
    await ctx.reply("This command works only inside a group.");
    return;
  }

  if (!(await isAdmin(ctx))) {
    await ctx.reply("Only group admins can use this command.");
    return;
  }

  const parts = (ctx.message?.text || "").trim().split(/\s+/);
  if (parts.length < 2) {
    await ctx.reply("Usage: /autourl <domain> <yes|no> exp=20");
    return;
  }

  const domain = normalizeDomain(parts[1]);
  const mode = (parts[2] || "no").toLowerCase();
  const opts = parseCommandOptions(parts.slice(2));
  const expiresIn = parseExpiresMinutes(opts.exp);
  if (!domain || (mode !== "yes" && mode !== "no")) {
    await ctx.reply("Usage: /autourl <domain> <yes|no> exp=20");
    return;
  }
  if (opts.exp !== undefined && expiresIn === null) {
    await ctx.reply(`exp must be 1 to ${MAX_EXPIRES_MINUTES} minutes.`);
    return;
  }

  const rule = await upsertRule(ctx.chat.id, domain, mode === "yes", expiresIn);
  await ctx.reply(
    panel("Rule Saved", [
      `Domain: <code>${esc(rule.domain)}</code>`,
      `Mode: <b>${rule.deleteOriginal ? "yes" : "no"}</b>`,
      `Expire: <b>${rule.expiresIn ? `${rule.expiresIn}m` : "default"}</b>`
    ]),
    { parse_mode: "HTML", ...uiKeyboard() }
  );
});

bot.command("listautourl", async (ctx) => {
  if (!(await ensureGroupPolicy(ctx))) return;
  if (!isGroup(ctx)) {
    await ctx.reply("Use this command inside a group.");
    return;
  }
  const rules = await listRules(ctx.chat.id);
  if (!rules.length) {
    await ctx.reply(panel("Auto Rules", ["No rules set in this group yet."]), { parse_mode: "HTML", ...uiKeyboard() });
    return;
  }
  const lines = rules.map(
    (r) =>
      `• <code>${esc(r.domain)}</code> — <b>${r.deleteOriginal ? "yes" : "no"}</b>${r.expiresIn ? `, ${r.expiresIn}m` : ""}`
  );
  await ctx.reply(panel("Auto Rules", lines), { parse_mode: "HTML", ...uiKeyboard() });
});

bot.command("removeautourl", async (ctx) => {
  if (!(await ensureGroupPolicy(ctx))) return;
  if (!isGroup(ctx)) {
    await ctx.reply("Use this command inside a group.");
    return;
  }

  if (!(await isAdmin(ctx))) {
    await ctx.reply("Only group admin can use this command.");
    return;
  }

  const parts = (ctx.message?.text || "").trim().split(/\s+/);
  if (parts.length < 2) {
    await ctx.reply("Usage: /removeautourl <domain>");
    return;
  }

  const removed = await removeRule(ctx.chat.id, parts[1]);
  await ctx.reply(removed ? "Rule removed." : "Rule not found.", { ...uiKeyboard() });
});

bot.command("short", async (ctx) => {
  if (!(await ensureDmJoinPolicy(ctx))) return;
  if (!(await ensureGroupPolicy(ctx))) return;
  const text = (ctx.message?.text || "").trim();
  const parts = text.split(/\s+/).slice(1);
  const url = parts.find((p) => /^https?:\/\//i.test(p));
  if (!url) {
    await ctx.reply("Usage: /short <url> alias=name exp=20 domain=id");
    return;
  }
  const opts = parseCommandOptions(parts);
  const expiresIn = parseExpiresMinutes(opts.exp);
  if (opts.exp !== undefined && expiresIn === null) {
    await ctx.reply(`exp must be 1 to ${MAX_EXPIRES_MINUTES} minutes.`);
    return;
  }
  try {
    const shortUrl = await shortenUrl(url, {
      customAlias: opts.alias,
      expiresIn,
      domainId: opts.domain
    });
    await ctx.reply(panel("Short URL Ready", [`<code>${esc(shortUrl)}</code>`]), {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...uiKeyboard()
    });
  } catch (error) {
    await ctx.reply(`Shorten failed: ${error?.message || "unknown error"}`, { ...uiKeyboard() });
  }
});

bot.command("mylinks", async (ctx) => {
  if (!(await ensureDmJoinPolicy(ctx))) return;
  if (!(await ensureGroupPolicy(ctx))) return;
  const parts = (ctx.message?.text || "").trim().split(/\s+/).slice(1);
  const search = parts.join(" ").trim();
  try {
    const data = await listLinks({ page: 1, limit: 10, search: search || undefined, active: true });
    const links = normalizeLinkList(data);
    if (!links.length) {
      await ctx.reply(panel("My Links", ["No links found."]), { parse_mode: "HTML", ...uiKeyboard() });
      return;
    }
    const rows = links.slice(0, 10).map((l) => {
      const id = l.id || l.linkId || "n/a";
      const shortUrl = l.shortUrl || l.shortURL || l.url || "n/a";
      const originalUrl = l.originalUrl || l.targetUrl || "";
      return `<code>${esc(id)}</code>\n<code>${esc(shortUrl)}</code>\n${esc(originalUrl)}`;
    });
    await ctx.reply(panel("My Latest Links", rows), {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...uiKeyboard()
    });
  } catch (error) {
    await ctx.reply(`List failed: ${error?.message || "unknown error"}`, { ...uiKeyboard() });
  }
});

bot.command("linkinfo", async (ctx) => {
  if (!(await ensureDmJoinPolicy(ctx))) return;
  if (!(await ensureGroupPolicy(ctx))) return;
  const parts = (ctx.message?.text || "").trim().split(/\s+/);
  const linkId = parts[1];
  if (!linkId) {
    await ctx.reply("Usage: /linkinfo <linkId>");
    return;
  }
  try {
    const link = await getLink(linkId);
    const shortUrl = link.shortUrl || link.shortURL || link.url || "n/a";
    const originalUrl = link.originalUrl || link.targetUrl || "n/a";
    const isActive = link.isActive ?? link.active ?? "n/a";
    const expiresAt = link.expiresAt || "none";
    await ctx.reply(
      panel("Link Info", [
        `ID: <code>${esc(linkId)}</code>`,
        `Active: <b>${isActive}</b>`,
        `Expires: <b>${expiresAt}</b>`,
        `Short: <code>${esc(shortUrl)}</code>`,
        `Original: ${esc(originalUrl)}`
      ]),
      { parse_mode: "HTML", disable_web_page_preview: true, ...uiKeyboard() }
    );
  } catch (error) {
    await ctx.reply(`Link info failed: ${error?.message || "unknown error"}`, { ...uiKeyboard() });
  }
});

bot.command("stats", async (ctx) => {
  if (!(await ensureDmJoinPolicy(ctx))) return;
  if (!(await ensureGroupPolicy(ctx))) return;
  const parts = (ctx.message?.text || "").trim().split(/\s+/);
  const linkId = parts[1];
  const days = Number(parts[2] || 30);
  if (!linkId) {
    await ctx.reply("Usage: /stats <linkId> [days]");
    return;
  }
  try {
    const stats = await getStats(linkId, Number.isFinite(days) ? days : 30, 1000);
    const total = stats.totalClicks ?? stats.clicks ?? stats.total ?? "n/a";
    const unique = stats.uniqueClicks ?? stats.unique ?? "n/a";
    await ctx.reply(
      panel("Link Stats", [
        `ID: <code>${esc(linkId)}</code>`,
        `Days: <b>${Number.isFinite(days) ? days : 30}</b>`,
        `Total clicks: <b>${total}</b>`,
        `Unique clicks: <b>${unique}</b>`
      ]),
      { parse_mode: "HTML", ...uiKeyboard() }
    );
  } catch (error) {
    await ctx.reply(`Stats failed: ${error?.message || "unknown error"}`, { ...uiKeyboard() });
  }
});

bot.command("domains", async (ctx) => {
  if (!(await ensureDmJoinPolicy(ctx))) return;
  if (!(await ensureGroupPolicy(ctx))) return;
  try {
    const data = await listDomains();
    const domains = Array.isArray(data) ? data : data?.domains || data?.items || [];
    if (!domains.length) {
      await ctx.reply(panel("Domains", ["No domains found."]), { parse_mode: "HTML", ...uiKeyboard() });
      return;
    }
    const list = domains
      .slice(0, 20)
      .map((d) => `• <code>${esc(d.domain || d.host || d.name || d)}</code>`)
      .join("\n");
    await ctx.reply(panel("Domains", [list]), { parse_mode: "HTML", ...uiKeyboard() });
  } catch (error) {
    await ctx.reply(`Domains failed: ${error?.message || "unknown error"}`, { ...uiKeyboard() });
  }
});

function getIncomingText(ctx) {
  return ctx.message?.text || ctx.message?.caption || "";
}

function getMessageTextWithoutUrls(text) {
  return text.replace(/https?:\/\/[^\s]+/gi, " ").replace(/\s+/g, " ").trim();
}

function buildSenderLabel(from) {
  if (!from) return "unknown";
  if (from.username) return `@${from.username}`;
  const fullName = [from.first_name, from.last_name].filter(Boolean).join(" ").trim();
  return fullName || `user_${from.id}`;
}

async function handleIncomingMessage(ctx) {
  if (!(await ensureGroupPolicy(ctx))) return;
  if (!isGroup(ctx)) return;
  const incomingText = getIncomingText(ctx);
  if (!incomingText) return;
  if (incomingText.startsWith("/")) return;
  if (!ctx.from?.id) return;

  const rules = await listRules(ctx.chat.id);
  if (!rules.length) return;

  const urls = extractUrls(incomingText);
  if (!urls.length) return;

  const matched = pickMatchedUrl(urls, rules);
  if (!matched) return;
  const now = Date.now();
  const userKey = `${ctx.chat.id}:${ctx.from.id}`;
  const lastUserAction = userCooldown.get(userKey) || 0;
  if (now - lastUserAction < COOLDOWN_MS) return;
  userCooldown.set(userKey, now);

  const duplicateKey = `${ctx.chat.id}:${matched.url}`;
  const lastUrlSeen = recentUrlInChat.get(duplicateKey) || 0;
  if (now - lastUrlSeen < DUPLICATE_WINDOW_MS) return;
  recentUrlInChat.set(duplicateKey, now);

  try {
    const shortUrl = await shortenUrl(matched.url, { expiresIn: matched.rule.expiresIn });
    const messageText = getMessageTextWithoutUrls(incomingText);
    const sender = buildSenderLabel(ctx.from);
    const replyLines = [
      messageText ? `Message: ${esc(messageText)}` : null,
      `Short URL: <code>${esc(shortUrl)}</code>`,
      `From: <b>${esc(sender)}</b>`
    ].filter(Boolean);

    await ctx.reply(panel("Auto Shortened", replyLines), {
      parse_mode: "HTML",
      reply_parameters: { message_id: ctx.message.message_id },
      disable_web_page_preview: true,
      ...uiKeyboard()
    });

    if (matched.rule.deleteOriginal) {
      try {
        await ctx.deleteMessage(ctx.message.message_id);
      } catch {
        await ctx.reply("I could not delete message. Give me delete permission.", { ...uiKeyboard() });
      }
    }
  } catch (error) {
    await ctx.reply(
      `Shorten failed for ${matched.rule.domain}: ${error?.message || "unknown error"}`,
      {
        reply_parameters: { message_id: ctx.message.message_id },
        disable_web_page_preview: true,
        ...uiKeyboard()
      }
    );
  }
}

bot.on("text", handleIncomingMessage);
bot.on("photo", handleIncomingMessage);
bot.on("video", handleIncomingMessage);
bot.on("document", handleIncomingMessage);
bot.on("animation", handleIncomingMessage);

bot.catch(async (error, ctx) => {
  await ctx.reply(`Error: ${error?.message || "unknown"}`);
});

bot.launch();
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
