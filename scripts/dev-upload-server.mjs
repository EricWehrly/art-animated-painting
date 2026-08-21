// One-off dev tool: a tiny local HTTP server that accepts a POSTed PNG (raw bytes) and writes
// it to disk. Used to pull a canvas.toDataURL() screenshot out of the browser sandbox in an
// environment with no working screenshot tool — never shipped, not part of the app.
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";

const port = Number(process.argv[2] ?? 8877);
const outPath = process.argv[3] ?? "screenshot.png";

const server = createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }

  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const buf = Buffer.concat(chunks);
    await writeFile(outPath, buf);
    console.log(`Wrote ${buf.length} bytes to ${outPath}`);
    res.writeHead(200).end("ok");
    server.close();
  });
});

server.listen(port, () => console.log(`listening on ${port}, writing to ${outPath}`));
