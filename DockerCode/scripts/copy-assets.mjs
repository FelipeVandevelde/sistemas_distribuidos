import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const source = resolve("img");
const destination = resolve("dist", "img");

await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
