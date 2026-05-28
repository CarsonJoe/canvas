## OpenAI Image Generation

**API** (`src/api/openai.ts`)
- `generateImage(prompt)` — DALL-E text-to-image
- `editImage(prompt, imageData)` — inpainting / outpainting

**Key management** (`src/services/openaiKey.ts`)
- BYOK: user supplies their own API key
- Stored in localStorage (never sent to any server)

**Result handling**
- Generated image inserted as `frame` with `kind: "image"`
- Supports outpainting via `priorBounds` tracking
