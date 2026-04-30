---
name: formation
description: Start or continue a Parago mind formation session with the user. Use when the user says /form, /formation, /parago, or "start formation". Routes conversation through the formation engine to build a cognitive model of the user.
---

# /formation - Parago Mind Formation

Start or continue a formation session. Formation builds a persistent cognitive model of the user through structured conversation.

## How it works

The formation engine is at /workspace/group/ventures/altego/formation-cli.ts. It handles the conversation, belief extraction, and profile synthesis. You are the relay - pass messages through and return results.

## Starting formation

When the user triggers formation, initialise by sending their first message:

```bash
cd /workspace/group/ventures/altego && npx tsx formation-cli.ts message "<userId>" "<channel>" "hello"
```

- userId: Use the sender name or ID from the message context (e.g., "Lucas", "user-123")
- channel: The channel type - "whatsapp", "telegram", "discord", or "native"

The CLI returns JSON with a reply field. Send that reply to the user verbatim.

## Continuing formation

For every subsequent message from a user in an active formation session, pass it through:

```bash
cd /workspace/group/ventures/altego && npx tsx formation-cli.ts message "<userId>" "<channel>" "<their message text>"
```

Parse the JSON output. Send the reply field back to the user. Do NOT add your own commentary - the formation engine manages the conversation flow.

## Formation commands

Users can send these during formation:
- /status or "status" - shows formation progress
- /mirror or "what do you know about me" - shows what the mind believes
- /pause - pauses formation
- /skip - skips current question
- /resume - resumes paused formation

Pass these through the same CLI - it handles them.

## Other CLI commands

```bash
# Check formation status
npx tsx formation-cli.ts status "<userId>"

# Show the minds mirror (what it believes about the user)
npx tsx formation-cli.ts mirror "<userId>"

# Get synthesised profile
npx tsx formation-cli.ts profile "<userId>"

# Get belief injection context (for system prompt)
npx tsx formation-cli.ts inject "<userId>" [topicHint]

# Export full mind state
npx tsx formation-cli.ts export "<userId>"
```

## When formation is complete

The JSON outputs signals.triggerBackgroundFormation field will be true when enough data has been gathered. The CLI automatically triggers profile synthesis.

After formation completes, the users profile is available at:
/workspace/group/parago-minds/<userId>/profile/profile.json

## Important

- Never fabricate formation responses - always use the CLI
- The formation engine uses Claude Haiku for belief extraction (cost-efficient)
- Formation state persists between sessions in /workspace/group/parago-minds/<userId>/
- The user owns their data - they can ask to see or export it at any time
