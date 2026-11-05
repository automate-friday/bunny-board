// Entry point of server/dist/bunny.cjs (npm run build:cli; bin/bunny runs it).
import path from "node:path";
import { main } from "./cli";

// server/dist/bunny.cjs sits two levels below the checkout.
const bunnyRoot = path.resolve(__dirname, "..", "..");
void main(process.argv.slice(2), { out: (s) => console.log(s), err: (s) => console.error(s), bunnyRoot }).then((code) => {
  process.exitCode = code;
});
