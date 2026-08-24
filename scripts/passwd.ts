import argon2 from "argon2";

const password = process.argv[2];
if (!password || password.length < 12)
  throw new Error(
    "Usage: pnpm webui:passwd <password of at least 12 characters>",
  );
process.stdout.write(
  `${await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 })}\n`,
);
