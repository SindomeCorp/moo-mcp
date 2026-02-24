# MOO MCP

A lightweight MCP server for connecting to a MOO.

## Requirements

1. Node 22 (might work on earlier versions by 22 for sure works)

## Warning

DO NOT CONNECT THIS TO A PRODUCTION MOO. USE ONLY ON A DEV MOO LIKE development MOO.

## MOO Setup

In order for this to work you need a 'MOOBot' type account on the MOO.

Get a $justice to:
- @make-player MOOBot1234 <your email>
- @programmer MOOBot1234
- @chparent MOOBot1234 to $generic_moo_bot ($agent child)
- @ansi off on the bot
- bot:rp_info_add({"DEFAULT-@VERBS-MODE", "d -c=no -u"})
- Get the username and pw

Slack Slither your IP and ask him to whitelist it for connecting directly to the MOO on port 5555

## Installation

Clone the repo locally and then:

```
npm install
cp .env.example .env
```

Edit the .env file and add your user and password for your MOO bot

## Adding to Codex

You don't need to directly add it to codex, there is a config file in the MOO-Codex repo which will do it for you.

## Utilizing

You need to get the MOO-codex repo as well. This contains the 'brains' of the integration.

Clone that repo: [MOO Codex](https://github.com/sevenecks/moo-codex)

Inside that repo:

- Update the .codex/config.toml file to the correct path to your MOO MCP folder
- run 'codex' from the command line
- connect to development MOO on your bit and confirm your MOOBot is online

If you want to see what it see's on the MOO, you can ask a $justice to help you monitor it directly.
