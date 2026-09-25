// scripts/build-compact-map.mjs - builds assets/hitzones-compact.svg, the
// shapes of the Compact map, by fusing provinces of assets/hitzones.svg.
//
// Each fused province is the geometric union of its parts (paper.js boolean
// operations, run in headless Chromium), so it has one outline and no inner
// border. Run it again after editing either map: npm run build:compact-map.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { COMPACT_MERGES } from '../data/maps/compact.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = `${ROOT}assets/hitzones.svg`;
const TARGET = `${ROOT}assets/hitzones-compact.svg`;
const PAPER = `${ROOT}node_modules/paper/dist/paper-core.js`;
// Holes smaller than this share of the fused area are gaps between
// neighbouring outlines, not real holes, and are dropped.
const SLIVER_SHARE = 0.002;
// Where two parts do not quite share a border, their union keeps a hair-thin
// notch (or spur) that runs from the coast into the new province and draws
// as a stub of the old border. A notch is closed when its mouth is narrower
// than SEAM.mouth, it is on average thinner than SEAM.width, and it runs
// along more than one part. Units are those of the SVG paths (about 42 per
// map pixel).
const SEAM = { step: 4, mouth: 40, width: 10, maxLength: 4000 };

function readPath(svg, id) {
  const match = svg.match(new RegExp(`<path id="${id}"[^>]*?\\sd="([^"]*)"[^>]*>(?:</path>)?`));
  if (!match) throw new Error(`No path with id ${id} in ${SOURCE}`);
  if (/<path id="[A-Z]+"[^>]*transform=/.test(match[0])) throw new Error(`${id} has its own transform; fusing it is not supported.`);
  return { tag: match[0], d: match[1] };
}

export async function buildCompactMap({ log = console.log } = {}) {
  const svg = readFileSync(SOURCE, 'utf8');
  const jobs = Object.entries(COMPACT_MERGES).map(([id, parts]) => ({
    id,
    parts: parts.map((partId) => ({ id: partId, ...readPath(svg, partId) })),
  }));

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<canvas id="c" width="10" height="10"></canvas>');
    await page.addScriptTag({ path: PAPER });
    const results = await page.evaluate(({ jobs: fuseJobs, sliverShare, seam }) => {
      const paper = window.paper;
      paper.setup(document.getElementById('c'));
      const contoursOf = (item) => (item.children ? [...item.children] : [item]);
      const shoelace = (points) => {
        let sum = 0;
        points.forEach((point, index) => {
          const next = points[(index + 1) % points.length];
          sum += point.x * next.y - next.x * point.y;
        });
        return sum / 2;
      };

      // Finds, on each outline, the first hair-thin notch or spur left where
      // two parts met: a stretch of outline that leaves and comes back to
      // nearly the same point, encloses almost no area, and runs along more
      // than one part.
      function findSeams(fused, shapes) {
        const seams = [];
        contoursOf(fused).forEach((contour) => {
          const length = contour.length;
          const count = Math.ceil(length / seam.step);
          if (count < 8) return;
          const step = length / count;
          const points = [];
          for (let k = 0; k < count; k += 1) points.push(contour.getPointAt(k * step));
          const owners = points.map((point) => {
            let owner = -1;
            let nearest = Infinity;
            shapes.forEach((shape, index) => {
              const distance = shape.getNearestPoint(point).getDistance(point);
              if (distance < nearest) {
                nearest = distance;
                owner = index;
              }
            });
            return owner;
          });
          const maxSpan = Math.min(Math.floor(count / 2), Math.floor(seam.maxLength / step));
          for (let i = 0; i < count; i += 1) {
            for (let span = maxSpan; span * step > seam.mouth * 3; span -= 1) {
              const j = (i + span) % count;
              if (points[i].getDistance(points[j]) >= seam.mouth) continue;
              const loop = [];
              const owned = new Set();
              for (let t = 0; t <= span; t += 1) {
                loop.push(points[(i + t) % count]);
                owned.add(owners[(i + t) % count]);
              }
              if (owned.size < 2 || (2 * Math.abs(shoelace(loop))) / (span * step) >= seam.width) continue;
              seams.push({ contour, from: i * step, length: span * step });
              return;
            }
          }
        });
        return seams;
      }

      // Cuts a seam off along its mouth: the outline keeps everything but the
      // seam and closes with a straight line across the mouth, which fills a
      // notch and trims a spur alike. Editing the outline directly avoids
      // boolean operations on edges that coincide, which paper.js mishandles.
      function cutSeam({ contour, from, length }) {
        const outline = contour.clone({ insert: false });
        outline.splitAt(from);
        const rest = outline.splitAt(length);
        rest.firstSegment.handleIn = null;
        rest.lastSegment.handleOut = null;
        rest.closed = true;
        return rest;
      }

      function dropSlivers(fused) {
        if (!fused.children) return 0;
        const total = Math.abs(fused.area);
        let dropped = 0;
        for (const child of [...fused.children]) {
          if (Math.abs(child.area) < total * sliverShare) {
            child.remove();
            dropped += 1;
          }
        }
        return dropped;
      }

      return fuseJobs.map((job) => {
        const shapes = job.parts.map((part) => paper.PathItem.create(part.d));
        let fused = shapes[0];
        for (const shape of shapes.slice(1)) fused = fused.unite(shape, { insert: false });
        let dropped = dropSlivers(fused);
        const unitedArea = Math.abs(fused.area);
        let seams = 0;
        for (let pass = 0; pass < 12; pass += 1) {
          const found = findSeams(fused, shapes);
          if (!found.length) break;
          seams += found.length;
          for (const entry of found) {
            const outline = cutSeam(entry);
            if (entry.contour === fused) fused = outline;
            else entry.contour.replaceWith(outline);
          }
        }
        dropped += dropSlivers(fused);
        const total = Math.abs(fused.area);
        // Seams are hair-thin, so cutting them must leave the area as it was.
        if (Math.abs(total - unitedArea) > unitedArea * 0.001) {
          throw new Error(`${job.id}: closing seams changed the area from ${unitedArea} to ${total}`);
        }
        const pieces = fused.children ? fused.children.length : 1;
        return { id: job.id, d: fused.pathData, pieces, dropped, seams, area: total };
      });
    }, { jobs, sliverShare: SLIVER_SHARE, seam: SEAM });

    let output = svg;
    for (const job of jobs) {
      const result = results.find((entry) => entry.id === job.id);
      for (const part of job.parts) {
        if (part.id === job.id) {
          output = output.replace(part.tag, part.tag.replace(` d="${part.d}"`, ` d="${result.d}"`));
        } else {
          output = output.replace(part.tag, '');
        }
      }
      log(`${job.id}: ${job.parts.map((part) => part.id).join(' + ')} -> ${result.pieces} outline(s), ${result.seams} seam(s) closed, ${result.dropped} sliver(s) dropped`);
    }
    writeFileSync(TARGET, output);
    return results;
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await buildCompactMap();
}
