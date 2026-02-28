import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.resolve(__dirname, "../../data");
const dataFile = path.join(dataDir, "groupRules.json");

async function ensureStore() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    await fs.access(dataFile);
  } catch {
    await fs.writeFile(dataFile, "{}", "utf8");
  }
}

async function readStore() {
  await ensureStore();
  const raw = await fs.readFile(dataFile, "utf8");
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeStore(store) {
  await ensureStore();
  await fs.writeFile(dataFile, JSON.stringify(store, null, 2), "utf8");
}

function cleanDomain(value) {
  const v = value.trim().toLowerCase().replace(/^https?:\/\//, "");
  return v.split("/")[0];
}

export function normalizeDomain(input) {
  return cleanDomain(input).replace(/^www\./, "");
}

export async function listRules(chatId) {
  const store = await readStore();
  return store[String(chatId)] || [];
}

export async function upsertRule(chatId, domain, deleteOriginal, expiresIn) {
  const key = String(chatId);
  const clean = normalizeDomain(domain);
  const store = await readStore();
  const rules = store[key] || [];
  const index = rules.findIndex((r) => r.domain === clean);
  const previous = index >= 0 ? rules[index] : null;
  const nextRule = {
    domain: clean,
    deleteOriginal: Boolean(deleteOriginal),
    expiresIn: Number.isFinite(expiresIn) ? Number(expiresIn) : previous?.expiresIn ?? null
  };
  if (index >= 0) {
    rules[index] = nextRule;
  } else {
    rules.push(nextRule);
  }
  store[key] = rules;
  await writeStore(store);
  return nextRule;
}

export async function removeRule(chatId, domain) {
  const key = String(chatId);
  const clean = normalizeDomain(domain);
  const store = await readStore();
  const rules = store[key] || [];
  const next = rules.filter((r) => r.domain !== clean);
  store[key] = next;
  await writeStore(store);
  return next.length !== rules.length;
}
