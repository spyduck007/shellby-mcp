import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import test from "node:test"
import sharp from "sharp"
import { fitExternalMcpResult } from "../src/external-mcp/result-images.js"

test("large image responses become viewable native MCP image previews", async () => {
  const width = 1400
  const height = 900
  const input = await sharp(randomBytes(width * height * 3), {
    raw: { width, height, channels: 3 },
  })
    .png()
    .toBuffer()
  const original = {
    content: [
      { type: "image" as const, mimeType: "image/png", data: input.toString("base64") },
      { type: "text" as const, text: "Blender render complete" },
    ],
  }
  assert.ok(Buffer.byteLength(JSON.stringify(original)) > 1_000_000)

  const output = await fitExternalMcpResult(original)
  assert.ok(Buffer.byteLength(JSON.stringify(output)) <= 1_000_000)
  const image = output.content[0]
  assert.equal(image?.type, "image")
  if (image?.type !== "image") throw new Error("Expected a native MCP image block")
  assert.equal(image.mimeType, "image/jpeg")
  const decoded = Buffer.from(image.data, "base64")
  const metadata = await sharp(decoded).metadata()
  assert.equal(metadata.format, "jpeg")
  assert.ok(metadata.width && metadata.width <= width)
  assert.ok(metadata.height && metadata.height <= height)
  assert.deepEqual(output.content[1], original.content[1])
})

test("small external images pass through unchanged", async () => {
  const png = await sharp({ create: { width: 80, height: 80, channels: 3, background: "blue" } })
    .png()
    .toBuffer()
  const result = {
    content: [{ type: "image" as const, mimeType: "image/png", data: png.toString("base64") }],
  }
  assert.strictEqual(await fitExternalMcpResult(result), result)
})

test("large text-only external responses remain rejected", async () => {
  await assert.rejects(
    () => fitExternalMcpResult({ content: [{ type: "text", text: "X".repeat(1_100_000) }] }),
    /1 MB response limit/u
  )
})
