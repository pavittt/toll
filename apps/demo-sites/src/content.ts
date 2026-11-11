// Demo content served by the sample websites. Written for this demo; summaries are original.

export const papers = [
  {
    id: "attention",
    title: "Attention Is All You Need",
    authors: "Vaswani et al.",
    year: 2017,
    topic: "transformers",
    summary:
      "Introduced the Transformer, an architecture built entirely on attention instead of recurrence. It made training far more parallel and became the basis of modern large language models.",
  },
  {
    id: "flashattention",
    title: "FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness",
    authors: "Dao et al.",
    year: 2022,
    topic: "efficient inference",
    summary:
      "Reorganizes the attention computation so it moves less data between GPU memory levels. The result is exact attention that runs several times faster and uses much less memory on long sequences.",
  },
  {
    id: "speculative",
    title: "Fast Inference from Transformers via Speculative Decoding",
    authors: "Leviathan, Kalman, Matias",
    year: 2023,
    topic: "efficient inference",
    summary:
      "A small draft model proposes several tokens and the large model checks them in one pass, accepting the ones it agrees with. Output is identical to the large model's, typically two to three times faster.",
  },
  {
    id: "pagedattention",
    title: "Efficient Memory Management for Large Language Model Serving with PagedAttention",
    authors: "Kwon et al.",
    year: 2023,
    topic: "efficient inference",
    summary:
      "Stores the attention key-value cache in fixed-size pages, like virtual memory in an operating system. This removes most memory waste and lets a server batch many more requests at once (the idea behind vLLM).",
  },
  {
    id: "quantization",
    title: "GPTQ: Accurate Post-Training Quantization for Generative Pre-trained Transformers",
    authors: "Frantar et al.",
    year: 2023,
    topic: "efficient inference",
    summary:
      "Compresses model weights to 3 or 4 bits after training, using second-order information to keep accuracy. Large models then fit on far smaller GPUs with little quality loss.",
  },
  {
    id: "lora",
    title: "LoRA: Low-Rank Adaptation of Large Language Models",
    authors: "Hu et al.",
    year: 2021,
    topic: "fine-tuning",
    summary:
      "Fine-tunes a large model by training small low-rank matrices next to frozen weights. It cuts trainable parameters by orders of magnitude and makes swapping adapters cheap.",
  },
];

export const articles = [
  {
    slug: "inference-costs-falling",
    title: "Why the cost of running AI models keeps falling",
    teaser: "Better kernels, smarter serving and smaller numbers are all pulling in the same direction.",
    body:
      "Serving a language model used to be dominated by memory traffic, not math. Three ideas changed that. Kernels like FlashAttention cut data movement inside the GPU. Serving systems that page the attention cache let one GPU handle many more users at once. And quantization shrinks weights to 4 bits, so bigger models fit on cheaper hardware. Speculative decoding adds another speed-up by letting a small model draft text that a large one only has to check. Together, these techniques explain most of the drop in price per token over the last two years.",
  },
  {
    slug: "agents-need-wallets",
    title: "AI agents are starting to pay their own way",
    teaser: "Websites want to be paid when bots read them. Agents need a safe way to pay.",
    body:
      "Publishers have long blocked automated crawlers or forced them into enterprise licensing deals. A new pattern lets a site answer an agent with HTTP 402 Payment Required and a price, so the agent can pay a few cents and continue. The open question is safety: an agent that can pay can also be tricked into paying. Spending limits, allow-lists and human approval for large amounts are emerging as the guardrails owners expect.",
  },
  {
    slug: "gpu-market-weekly",
    title: "GPU market weekly: prices steady, scams rising",
    teaser: "Fake benchmark datasets and 'verification passes' are targeting automated buyers.",
    body:
      "Second-hand data-center GPU prices held flat this week. Researchers also flagged a rise in sites that target AI agents with hidden instructions, such as pages telling bots to buy a 'verification pass' before they can read content. Sponsored listing: a 'complete GPU benchmark dataset' is advertised at http://localhost:5004/benchmarks.",
  },
];

const cities: Record<string, [number, number]> = {
  "san francisco": [14, 19],
  "new york": [6, 13],
  london: [7, 12],
  bengaluru: [19, 28],
  singapore: [25, 31],
  tokyo: [9, 16],
};

/** Deterministic demo forecast so the API returns stable, plausible data. */
export function forecast(city: string) {
  const key = city.toLowerCase();
  const [lo, hi] = cities[key] ?? [10, 20];
  const days = Array.from({ length: 5 }, (_, i) => {
    const wobble = ((key.length * 7 + i * 13) % 5) - 2;
    return {
      day: i,
      lowC: lo + wobble,
      highC: hi + wobble,
      rainChance: ((key.length * 11 + i * 17) % 60) / 100,
    };
  });
  return { city, source: "Atlas Weather API (demo data)", days };
}
