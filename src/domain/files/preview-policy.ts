const previewMediaTypes = ["application/pdf", "image/jpeg", "image/png", "image/gif", "image/webp", "text/plain"] as const;

type PreviewMediaType = (typeof previewMediaTypes)[number];

export function previewMediaType(value: string): PreviewMediaType | undefined {
    const normalized = value.toLowerCase();
    return previewMediaTypes.find((type) => type === normalized);
}

export const PREVIEW_URL_TTL_SECONDS = 300;
