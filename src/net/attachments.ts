/**
 * Images entering a turn.
 *
 * The kernel stores an uploaded image under `.reasonix/attachments` and answers
 * with the `@path` token a message must contain. It sniffs the bytes itself, so
 * this module never decides that a file is an image from its name alone; it only
 * refuses clearly impossible uploads before spending the bytes.
 *
 * This uses the JSON endpoint, not `/attachments/upload`: the current kernel
 * refuses the raw route with `request.bad_content_type` once it is reached
 * through the runtime prefix, while the JSON route was verified live. The
 * kernel's own cap for an image is 10 MB, well under the JSON body bound.
 */

export const MAX_IMAGE_MB = 10;

const IMAGE_REF = /@([^\s@]+\.(?:png|jpe?g|gif|webp|bmp|heic|heif))/gi;

/**
 * A reference is a token, not a prefix: `@photo.png看这个` names one long path
 * and the kernel will not recognise the image. Put whitespace on either side
 * when the person's own text touches the reference.
 */
export function isolateImageRefs(text: string): string {
  return text.replace(
    IMAGE_REF,
    (match: string, _path: string, offset: number, whole: string) => {
      const before = whole[offset - 1] ?? "";
      const after = whole[offset + match.length] ?? "";
      const left = before !== "" && !/\s/.test(before) ? " " : "";
      const right = after !== "" && !/\s/.test(after) ? " " : "";
      return `${left}${match}${right}`;
    },
  );
}

export interface UploadedAttachment {
  path: string;
  ref: string;
  image?: boolean;
}

export type AttachmentResult =
  | { ok: true; attachment: UploadedAttachment }
  | { ok: false; code: string };

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  heic: "image/heic",
  heif: "image/heif",
};

function mimeFor(name: string, supplied: string): string {
  if (supplied) return supplied;
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  return MIME[extension] ?? "";
}

async function failureCode(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { code?: unknown };
    if (body && typeof body === "object" && typeof body.code === "string") return body.code;
  } catch {
    // fall through to the status
  }
  return `http.${response.status}`;
}

async function base64Of(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export async function uploadImage(base: string, file: File): Promise<AttachmentResult> {
  const name = file.name || "image";
  const mime = mimeFor(name, file.type);
  if (!mime.startsWith("image/")) {
    return { ok: false, code: "attachment.unsupported_image" };
  }
  if (file.size > MAX_IMAGE_MB * 1024 * 1024) {
    return { ok: false, code: "attachment.too_large" };
  }
  try {
    const data = await base64Of(file);
    const response = await fetch(`${base}/attachments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ name, mime, data }),
    });
    if (!response.ok) return { ok: false, code: await failureCode(response) };
    const body = (await response.json()) as Partial<UploadedAttachment>;
    if (typeof body.ref !== "string" || !body.ref || typeof body.path !== "string") {
      return { ok: false, code: "attachment.shape" };
    }
    return {
      ok: true,
      attachment: {
        path: body.path,
        ref: body.ref,
        ...(body.image === true ? { image: true } : {}),
      },
    };
  } catch {
    return { ok: false, code: "client.offline" };
  }
}
