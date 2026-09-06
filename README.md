# Discord Link Blocker

A small Discord bot that removes Discord invite links from server messages and posts a short warning.

## Setup

1. Create an application and bot in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Enable **Message Content Intent** under the bot's privileged gateway intents.
3. Invite the bot with the `bot` scope and these permissions:
	- View Channels
	- Send Messages
	- Manage Messages
4. Install dependencies:

	```sh
	npm install
	```

5. Copy `.env.example` to `.env` and set `DISCORD_TOKEN` to your bot token.
6. Start the bot:

	```sh
	npm start
	```

## Run 24/7

For continuous uptime, deploy this repository as a worker service on Railway, Render, or another host that supports long-running Docker containers. Do not use this VS Code terminal as the permanent host.

Using a hosting provider:

1. Push this repository to GitHub.
2. Create a new service from the repository.
3. Choose the included `Dockerfile` (or use the start command `npm start`).
4. Add an environment variable named `DISCORD_TOKEN` containing your bot token.
5. Deploy and check the logs for `Logged in as ...`.

The host should automatically restart the container if it stops. Keep `.env` local; it is ignored by Git and should never be committed.

The bot blocks links matching `discord.gg`, `discord.com/invite`, and `discordapp.com/invite`. It sends the removal notice privately to the user who posted the link, so it does not create a public anti-link message. It ignores messages sent by other bots and only moderates messages in servers.

### Render deployment

Deploy this repository as a **Background Worker** on Render. The included `render.yaml` and `Dockerfile` configure the service to run `bot.js`. Add `DISCORD_TOKEN` as a secret environment variable in Render before deploying.