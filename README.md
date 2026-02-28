# Telegram Link Shortner Bot

## Setup

1. Install:
   - `npm install`
2. Copy env:
   - `copy .env.example .env`
3. Add values in `.env`:
   - `BOT_TOKEN`
   - `SHORTNER_API_KEY`
   - `SHORTNER_BASE_URL` (default: `https://linkshortner.co`)
4. Run:
   - `npm start`

## Commands

- `/autourl <domain> <yes|no> exp=20`
- `/listautourl`
- `/removeautourl <domain>`
- `/short <url> alias=name exp=20 domain=id`
- `/mylinks [search]`
- `/linkinfo <linkId>`
- `/stats <linkId> [days]`
- `/domains`

## yes/no behavior

- `yes`: shorten matching link and delete original message
- `no`: shorten matching link and keep original message
- `exp=<minutes>` can be set by admin on `/autourl` for auto-created links
- `exp` max is `10080` minutes (7 days)

## Advanced behavior

- Supports text and caption links (photo/video/document/animation)
- Auto reply includes remaining message text and sender reference
- Duplicate same URL in same group is suppressed for 45 seconds
- Per-user auto-shorten cooldown is 5 seconds
- DM users must join `@BINBHAII` to use the bot
- In groups, bot must be admin and group owner must join `@BINBHAII`
- All users are stored in SQLite at `data/users.sqlite` (user id and username)

## Notes

- This commit is a deploy trigger update.
