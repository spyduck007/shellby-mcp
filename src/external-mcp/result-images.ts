import type { CallToolResult } from "@modelcontextprotocol/client"
import sharp from "sharp"
import { encodeImageForMcp, ImageEncodingError } from "../tools/image/image-encoding.js"

const MAX_RESULT_BYTES = 1_000_000
const RESPONSE_HEADROOM_BYTES = 16 * 1024
const ENCODER_HEADROOM_BYTES = 64 * 1024
const PREVIEW_MAX_DIMENSIONS = [undefined, 1600, 1280, 960, 768, 640, 512, 384, 256] as const

/** Keep image-heavy external results usable without relaxing the general output cap. */
export async function fitExternalMcpResult(result: CallToolResult): Promise<CallToolResult> {
  const serializedSize = Buffer.byteLength(JSON.stringify(result), "utf8")
  if (serializedSize <= MAX_RESULT_BYTES) return result

  const images = result.content.filter((item) => item.type === "image")
  if (!images.length) throw new Error("External MCP result exceeds the 1 MB response limit")

  // Budget only the base64 payloads. Keep the original response metadata and
  // text unchanged, and reserve room for serialized JSON and future fields.
  const imageBase64Bytes = images.reduce((total, image) => total + image.data.length, 0)
  const fixedBytes = serializedSize - imageBase64Bytes
  const perImageBudget = Math.floor(
    (MAX_RESULT_BYTES - RESPONSE_HEADROOM_BYTES - fixedBytes) / images.length
  )
  if (perImageBudget <= ENCODER_HEADROOM_BYTES)
    throw new Error("External MCP result exceeds the 1 MB response limit")

  const content = await Promise.all(
    result.content.map(async (item) => {
      if (item.type !== "image" || item.data.length <= perImageBudget) return item
      const original = Buffer.from(item.data, "base64")

      for (const maxDimension of PREVIEW_MAX_DIMENSIONS) {
        const input = maxDimension
          ? await sharp(original)
              .resize({
                width: maxDimension,
                height: maxDimension,
                fit: "inside",
                withoutEnlargement: true,
              })
              .toBuffer()
          : original
        try {
          const image = await encodeImageForMcp(input, {
            maxResponseBytes: perImageBudget + ENCODER_HEADROOM_BYTES,
          })
          return { ...item, data: image.data, mimeType: image.mimeType }
        } catch (error) {
          if (error instanceof ImageEncodingError && error.code === "IMAGE_TOO_LARGE") continue
          throw error
        }
      }

      throw new Error("External MCP image cannot fit within the 1 MB response limit")
    })
  )

  const resized = { ...result, content }
  if (Buffer.byteLength(JSON.stringify(resized), "utf8") > MAX_RESULT_BYTES)
    throw new Error("External MCP result exceeds the 1 MB response limit")
  return resized
}
