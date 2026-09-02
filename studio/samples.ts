// Developer CLI for fragment indexing, inspection, artist planning, compilation and demo artifacts.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { buildSamplingIndex, cropRgb, loadSamplingIndex } from '../aesthetic/sample-index.js';
import { searchSamplingIndex } from '../aesthetic/sample-retrieval.js';
import { compileSamplingPlan, mountainBaseProgram } from '../aesthetic/sample-compiler.js';
import { assertSamplingPlan, controlsFor, type SampleChannel, type SampleRequest, type SamplingPlan } from '../aesthetic/sample-types.js';
import { loadMetCorpus } from '../env/sample-corpus.js';
import { decodeRgb, type RgbImage } from '../env/rgb.js';
import { contactSheet } from '../env/sheet.js';
import { encodePng } from '../env/png.js';
import { embedText, textAvailable, textUnavailableMessage } from '../artist/clip-text.js';
import { available as imageAvailable, embedRgb, embedRgbBatch, unavailableMessage as imageUnavailableMessage } from '../artist/resemblance.js';
import { createSamplingPlan, goalFromCommission, requestsFromGoal, validateArtistSampleRequests } from '../artist/sample-planner.js';

const cli = new Command().name('samples').description('intentional sampling from content-hashed artwork fragments');

function json(file: string, value: unknown): void {
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readCommission(file: string): Record<string, any> | string {
  const text = readFileSync(file, 'utf8');
  try { return JSON.parse(text) as Record<string, any>; }
  catch { return text.trim(); }
}

function rgba(image: RgbImage): { rgba: Buffer; width: number; height: number } {
  const out = Buffer.alloc(image.width * image.height * 4);
  for (let i = 0, j = 0; i < image.data.length; i += 3, j += 4) {
    out[j] = image.data[i]!; out[j + 1] = image.data[i + 1]!; out[j + 2] = image.data[i + 2]!; out[j + 3] = 255;
  }
  return { rgba: out, width: image.width, height: image.height };
}

function escape(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function writeContactSheet(indexDir: string, hits: ReturnType<typeof searchSamplingIndex>, file: string): void {
  const index = loadSamplingIndex(indexDir);
  const images = hits.map((hit) => {
    const source = path.resolve(index.header.sourceRoot, hit.fragment.sourceRelativePath);
    return rgba(cropRgb(decodeRgb(source), hit.fragment.pixelBounds));
  });
  const sheet = contactSheet(images, { cols: Math.min(4, Math.max(1, images.length)), cell: 220, gap: 12, background: [241, 239, 232] });
  writeFileSync(file, encodePng(sheet.rgba, sheet.width, sheet.height));
  const html = `<!doctype html><meta charset="utf-8"><title>Sampling search</title><style>body{font:14px system-ui;max-width:1000px;margin:2rem auto}img{max-width:100%}li{margin:.7rem 0}</style><h1>Sampling search</h1><img src="${escape(path.basename(file))}"><ol>${hits.map((hit) => `<li><b>${hit.rank}. ${escape(hit.fragment.provenance.title)}</b> — ${escape(hit.fragment.provenance.artist ?? 'unknown artist')}; Met ${hit.fragment.objectId}; crop ${hit.fragment.normalizedBounds.map((v) => v.toFixed(3)).join(', ')}; hybrid ${hit.scores.hybrid.toFixed(4)}; <a href="${escape(hit.fragment.provenance.objectPageUrl)}">source</a></li>`).join('')}</ol>`;
  writeFileSync(file.replace(/\.[^.]+$/, '.html'), html);
}

cli.command('index')
  .requiredOption('--corpus <manifest-or-dir>')
  .requiredOption('--output <index-dir>')
  .option('--limit <n>', 'maximum source works for a prototype index')
  .action(async (opts: { corpus: string; output: string; limit?: string }) => {
    if (!imageAvailable()) throw new Error(imageUnavailableMessage());
    const manifest = loadMetCorpus(opts.corpus);
    const corpusRoot = opts.corpus.endsWith('.json') || opts.corpus.endsWith('.jsonl') ? path.dirname(path.resolve(opts.corpus)) : path.resolve(opts.corpus);
    const header = await buildSamplingIndex({
      output: opts.output, corpusRoot, manifest, limit: opts.limit ? Number(opts.limit) : undefined,
      embed: (crop) => embedRgb(crop),
      embedBatch: (crops) => embedRgbBatch(crops),
    });
    process.stdout.write(`${JSON.stringify(header, null, 2)}\n`);
  });

cli.command('search')
  .requiredOption('--index <index-dir>')
  .requiredOption('--query <text>')
  .option('--negative <text...>', 'negative query or queries')
  .option('--channels <list>', 'comma-separated sampling channels', 'composition')
  .option('--top-k <n>', 'ranked candidates', '12')
  .option('--contact-sheet <file>')
  .option('--output <file>', 'machine-readable JSON (stdout when omitted)')
  .option('--department <list>')
  .option('--culture <list>')
  .option('--medium <list>')
  .option('--artist <list>')
  .option('--classification <list>')
  .action(async (opts: Record<string, string | string[] | undefined>) => {
    if (!textAvailable()) throw new Error(textUnavailableMessage());
    const index = loadSamplingIndex(String(opts.index));
    const [query, ...negative] = await embedText([String(opts.query), ...((opts.negative as string[] | undefined) ?? [])]);
    const list = (value: unknown) => typeof value === 'string' ? value.split(',').map((v) => v.trim()).filter(Boolean) : undefined;
    const request: SampleRequest = {
      requestId: 'inspection', role: 'inspection', query: String(opts.query), negativeQueries: (opts.negative as string[] | undefined) ?? [],
      channels: String(opts.channels).split(',').map((v) => v.trim()) as SampleChannel[], mode: 'reference_transfer',
      transformation: 'echo', preset: 'accent', controls: controlsFor('accent'), perceptualGoal: 'independent retrieval inspection',
      origin: 'fallback',
      filters: { department: list(opts.department), culture: list(opts.culture), medium: list(opts.medium), artist: list(opts.artist), classification: list(opts.classification) },
    };
    const hits = searchSamplingIndex(index, query!, request, { topK: Number(opts.topK), negativeEmbeddings: negative });
    const result = { indexId: index.header.indexId, request, hits };
    if (opts.output) json(String(opts.output), result);
    else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (opts.contactSheet) writeContactSheet(String(opts.index), hits, String(opts.contactSheet));
  });

async function planFrom(options: {
  commission: string;
  index: string;
  seed: number;
  artist?: string;
  temperature?: number;
}): Promise<SamplingPlan> {
  if (!textAvailable()) throw new Error(textUnavailableMessage());
  const input = readCommission(options.commission);
  const goal = goalFromCommission(input);
  const requests = validateArtistSampleRequests(typeof input === 'object' && input.requests ? input.requests : requestsFromGoal(goal));
  const index = loadSamplingIndex(options.index);
  const embeddingRows = await embedText(requests.flatMap((r) => [r.query, ...(r.negativeQueries ?? [])]));
  let at = 0;
  const vectors = new Map<string, { query: Float32Array; negative: Float32Array[] }>();
  for (const request of requests) {
    const query = embeddingRows[at++]!;
    const negative = (request.negativeQueries ?? []).map(() => embeddingRows[at++]!);
    vectors.set(request.requestId, { query, negative });
  }
  return createSamplingPlan({
    goal, requests, indexId: index.header.indexId, seed: options.seed, temperature: options.temperature,
    artistProfile: options.artist,
    candidates: async (request, excluded, excludedFragments) => {
      const vector = vectors.get(request.requestId)!;
      return searchSamplingIndex(index, vector.query, request, { topK: 10, candidatePool: 60, excludeObjectIds: new Set(excluded), excludeFragmentIds: new Set(excludedFragments), negativeEmbeddings: vector.negative });
    },
  });
}

cli.command('plan')
  .requiredOption('--commission <file>')
  .requiredOption('--index <index-dir>')
  .requiredOption('--output <sampling-plan.json>')
  .option('--artist <artist-profile>')
  .option('--seed <n>', 'stable selection seed', '42')
  .option('--temperature <n>', 'seeded candidate sampling temperature', '0.18')
  .action(async (opts: { commission: string; index: string; output: string; artist?: string; seed: string; temperature: string }) => {
    const plan = await planFrom({ commission: opts.commission, index: opts.index, seed: Number(opts.seed), artist: opts.artist, temperature: Number(opts.temperature) });
    json(opts.output, plan);
    process.stdout.write(`${opts.output}\n${plan.samples.map((s) => `  ${s.role.padEnd(12)} ${s.sampleId}  Met ${s.fragment.objectId}  ${s.fragment.provenance.title}`).join('\n')}\n`);
  });

cli.command('compile')
  .requiredOption('--sampling-plan <file>')
  .requiredOption('--output <program.json>')
  .option('--base <program.json>', 'native base program; defaults to the mountain base')
  .option('--disable <sample-id...>')
  .action((opts: { samplingPlan: string; output: string; base?: string; disable?: string[] }) => {
    const plan: unknown = JSON.parse(readFileSync(opts.samplingPlan, 'utf8'));
    assertSamplingPlan(plan);
    const base = opts.base ? JSON.parse(readFileSync(opts.base, 'utf8')) as Record<string, unknown> : mountainBaseProgram(plan.seed);
    const result = compileSamplingPlan(base, plan, opts.disable ?? []);
    json(opts.output, result.program);
    json(opts.output.replace(/\.json$/, '.sampling.json'), { ...result, program: undefined });
    process.stdout.write(`${opts.output}\n  ${result.constraints.filter((c) => c.supported).length} applied, ${result.unsupported.length} unsupported\n`);
  });

cli.command('demo')
  .argument('<name>', 'mountain | cross-medium | historical-collision')
  .requiredOption('--index <index-dir>')
  .requiredOption('--output <dir>')
  .option('--seed <n>', 'stable seed', '42')
  .action(async (name: string, opts: { index: string; output: string; seed: string }) => {
    const commissions: Record<string, string> = {
      mountain: path.join('examples', 'sampling', 'mountain-commission.json'),
      'cross-medium': path.join('examples', 'sampling', 'cross-medium-commission.json'),
      'historical-collision': path.join('examples', 'sampling', 'historical-collision-commission.json'),
    };
    const commission = commissions[name];
    if (!commission || !existsSync(commission)) throw new Error(`unknown demo ${name}`);
    mkdirSync(opts.output, { recursive: true });
    const seed = Number(opts.seed);
    const plan = await planFrom({ commission, index: opts.index, seed });
    const base = mountainBaseProgram(seed);
    const compiled = compileSamplingPlan(base, plan);
    json(path.join(opts.output, 'sampling-plan.json'), plan);
    json(path.join(opts.output, 'base-program.json'), base);
    json(path.join(opts.output, 'program.json'), compiled.program);
    json(path.join(opts.output, 'provenance.json'), { planId: plan.planId, constraints: compiled.constraints, unsupported: compiled.unsupported, records: compiled.provenance });
    const scale = plan.samples.find((sample) => sample.channels.includes('scale_relation'));
    if (scale) {
      const ablation = compileSamplingPlan(base, plan, [scale.sampleId]);
      json(path.join(opts.output, 'ablation-scale-disabled.program.json'), ablation.program);
      json(path.join(opts.output, 'ablation-scale-disabled.provenance.json'), { disabled: [scale.sampleId], constraints: ablation.constraints });
    }
    if (name === 'cross-medium') {
      const transposed = plan.samples.find((sample) => sample.channels.includes('mark_rhythm'));
      if (transposed) {
        for (const preset of ['whisper', 'dialogue', 'rupture'] as const) {
          const variant = JSON.parse(JSON.stringify(plan)) as SamplingPlan;
          const selected = variant.samples.find((sample) => sample.sampleId === transposed.sampleId)!;
          const request = variant.requests.find((item) => item.requestId === selected.requestId)!;
          selected.preset = preset; selected.controls = controlsFor(preset);
          request.preset = preset; request.controls = controlsFor(preset);
          const result = compileSamplingPlan(base, variant);
          json(path.join(opts.output, `program-${preset}.json`), result.program);
          json(path.join(opts.output, `provenance-${preset}.json`), { sourceSampleId: selected.sampleId, sourceObjectId: selected.fragment.objectId, preset, controls: selected.controls, constraints: result.constraints });
        }
      }
    }
    const hits = plan.samples.map((sample, rank) => ({ rank: rank + 1, fragment: sample.fragment, scores: sample.candidates.find((c) => c.fragment.fragmentId === sample.fragment.fragmentId)!.scores }));
    writeContactSheet(opts.index, hits, path.join(opts.output, 'selected-sources.png'));
    const extras = [scale ? 'scale ablation' : '', name === 'cross-medium' ? 'whisper/dialogue/rupture variants' : ''].filter(Boolean).join(', ');
    process.stdout.write(`${opts.output}\n  ${plan.samples.length} distinct Met sources; program, contact sheet, provenance${extras ? `, ${extras}` : ''} written\n`);
  });

await cli.parseAsync();
