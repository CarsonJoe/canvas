import OpenAI from 'openai';
import { getOpenAiApiKey } from '../services/openaiKey';

const IMAGE_MODEL = 'gpt-image-2';

type ImageSize = '1024x1024' | '1536x1024' | '1024x1536';

function pickSize(width: number, height: number): ImageSize {
  const ratio = width / height;
  if (ratio > 1.2) return '1536x1024';
  if (ratio < 0.8) return '1024x1536';
  return '1024x1024';
}

export async function generateImage(prompt: string, width: number, height: number): Promise<string> {
  const size = pickSize(width, height);
  const response = await createOpenAiClient().images.generate({
    model: IMAGE_MODEL,
    prompt,
    n: 1,
    size,
  });

  const item = response.data?.[0];
  if (item?.b64_json) return `data:image/png;base64,${item.b64_json}`;
  if (item?.url) return blobToDataUrl(await (await fetch(item.url)).blob());
  throw new Error('No image data in response');
}

// Shared implementation for both outpainting and inpainting.
// image: the reference PNG (existing content at correct position)
// mask: separate PNG; transparent pixels = generate here, opaque = preserve
export async function editImage(
  imageDataUrl: string,
  maskDataUrl: string,
  prompt: string,
  width: number,
  height: number,
  referenceImageDataUrls: string[] = [],
): Promise<string> {
  const size = pickSize(width, height);
  const imageFile = dataUrlToFile(imageDataUrl, 'image.png');
  const maskFile = dataUrlToFile(maskDataUrl, 'mask.png');
  const referenceFiles = referenceImageDataUrls.map((dataUrl, index) =>
    dataUrlToFile(dataUrl, `reference-${index + 1}.png`),
  );

  const response = await createOpenAiClient().images.edit({
    model: IMAGE_MODEL,
    image: referenceFiles.length > 0 ? [imageFile, ...referenceFiles] : imageFile,
    mask: maskFile,
    prompt,
    n: 1,
    size,
  });

  const item = response.data?.[0];
  if (item?.b64_json) return `data:image/png;base64,${item.b64_json}`;
  if (item?.url) return blobToDataUrl(await (await fetch(item.url as string)).blob());
  throw new Error('No image data in response');
}

function createOpenAiClient(): OpenAI {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) {
    throw new Error('Add your OpenAI API key before generating images.');
  }
  return new OpenAI({
    apiKey,
    dangerouslyAllowBrowser: true,
  });
}

function dataUrlToFile(dataUrl: string, filename: string): File {
  const [header, data] = dataUrl.split(',');
  const mime = header.match(/:(.*?);/)?.[1] ?? 'image/png';
  const bytes = atob(data);
  const buf = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
  return new File([buf], filename, { type: mime });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
