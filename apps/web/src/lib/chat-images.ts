// Screenshots attached to an Agent chat message (e.g. a "thanks for
// applying" page from a site that sends no email). The image goes to the
// user's agent once, with the message (task input `images`, limits in
// packages/schema/src/conversation.ts); the conversation keeps only a small
// preview. Large screenshots are scaled down so text stays legible but the
// task stays small.
import { CHAT_IMAGE_TYPES, MAX_CHAT_IMAGES, type ChatImage } from '@landed/schema/conversation'

export type Attachment = ChatImage & { name: string; thumb: string }

export { MAX_CHAT_IMAGES }

const MAX_SIDE = 2000 // px, longest side sent to the agent
const KEEP_AS_IS = 1_500_000 // bytes: small PNG/JPEG/WebP go unchanged (sharpest text)
const THUMB_SIDE = 240

function load(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file isn't an image Landed can read.")) }
    img.src = url
  })
}

function draw(img: HTMLImageElement, maxSide: number): HTMLCanvasElement {
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fff' // transparent PNGs → white, not black, as JPEG
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  return canvas
}

const base64Of = (dataUrl: string) => dataUrl.slice(dataUrl.indexOf(',') + 1)

async function fileBase64(file: Blob): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer())
  let s = ''
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000))
  return btoa(s)
}

/** A pasted, dropped or picked image → what the agent gets + a preview. */
export async function prepareImage(file: File): Promise<Attachment> {
  if (!file.type.startsWith('image/')) throw new Error(`${file.name || 'That file'} isn't an image.`)
  const img = await load(file)
  const small = file.size <= KEEP_AS_IS && CHAT_IMAGE_TYPES.includes(file.type) && Math.max(img.naturalWidth, img.naturalHeight) <= MAX_SIDE
  let type = file.type
  let data: string
  if (small) {
    data = await fileBase64(file)
  } else {
    type = 'image/jpeg'
    data = base64Of(draw(img, MAX_SIDE).toDataURL('image/jpeg', 0.88))
  }
  const thumb = draw(img, THUMB_SIDE).toDataURL('image/jpeg', 0.7)
  return { type, data_base64: data, name: file.name || 'screenshot', thumb }
}

/** Images from a paste or a drop (anything else is ignored). */
export function imagesFrom(list: DataTransfer | null): File[] {
  if (!list) return []
  const files = [...list.files].filter((f) => f.type.startsWith('image/'))
  if (files.length) return files
  return [...list.items].filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile()).filter((f): f is File => !!f)
}
