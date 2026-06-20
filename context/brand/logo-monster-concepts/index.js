// Sandpack and direct-browser entrypoint for the logo concept board.
// Keep all rendering here: Sandpack's vanilla template evaluates /index.js,
// and inline scripts in index.html are not reliable in the artifact iframe.

const app = document.getElementById('app');
if (!app) {
  throw new Error('Logo concept board mount node #app was not found.');
}

app.innerHTML = "<main>\n      <section class=\"hero\">\n        <div class=\"panel\">\n          <h1><span class=\"gradient\">Agor</span><br />pixel monster explorations</h1>\n          <p class=\"subtitle\">\n            A fast, reproducible concept board for a cute little Agor monster mascot/logo. The brief: start with the current teal/ink palette, keep it memorable at favicon size, make it non-threatening but a bit badass, and avoid anything too childish.\n          </p>\n          <div class=\"meta\">\n            <span class=\"pill\">SVG generated from tiny pixel grids</span>\n            <span class=\"pill\">No production logo replacement</span>\n            <span class=\"pill\">Designed for small-size review</span>\n          </div>\n        </div>\n        <aside class=\"panel palette\" aria-label=\"Palette notes\">\n          <h2>Palette source</h2>\n          <p style=\"margin:0;color:rgba(237,253,250,.72);line-height:1.55;font-size:.9rem\">Observed in <code>ThemeContext</code>, docs metadata, and existing logo assets.</p>\n          <div class=\"swatches\">\n            <div class=\"swatch\" style=\"background:#2e9a92\"><span>#2e9a92<br />primary teal</span></div>\n            <div class=\"swatch\" style=\"background:#3db4aa\"><span>#3db4aa<br />hover teal</span></div>\n            <div class=\"swatch\" style=\"background:#7fe8df;color:#072\"><span>#7fe8df<br />mint glow</span></div>\n            <div class=\"swatch\" style=\"background:#1b2029\"><span>#1b2029<br />logo ink</span></div>\n          </div>\n        </aside>\n      </section>\n\n      <section id=\"concepts\" class=\"concept-grid\" aria-label=\"Logo monster concepts\"></section>\n\n      <section class=\"panel notes\">\n        <h2>Direction notes</h2>\n        <div class=\"notes-grid\">\n          <div>\n            <ul>\n              <li><strong>Strongest overall:</strong> 01 Cyclops Command, 04 Branch Beast, and 07 Terminal Gremlin. They read fastest at 32px and feel most connected to Agor\u2019s command-center / branch / terminal world.</li>\n              <li><strong>Most mascot-forward:</strong> 03 Fluffy Orbit and 08 Soft Spike. Friendly without becoming a toy brand; useful if Max wants a character that can emote in empty states.</li>\n              <li><strong>Most logo-forward:</strong> 02 Shield Fuzz and 10 Portal Pup. These simplify into an app icon more naturally than a full mascot illustration.</li>\n            </ul>\n          </div>\n          <div>\n            <ul>\n              <li>All marks are intentionally built from a 16\u00d716-ish pixel vocabulary so they can be converted to standalone SVGs or CSS pixel art later.</li>\n              <li>Badass cues are kept small: horns, brows, terminal eyes, branch tails, and ink-heavy silhouettes. No sharp teeth gore, no horror language.</li>\n              <li>Next step: choose 2\u20133 directions and redraw them as production vectors with fewer internal details, then test at 16/24/32/48px and beside the lowercase <code>agor</code> docs wordmark.</li>\n            </ul>\n          </div>\n        </div>\n      </section>\n    </main>\n";

const colors = {
        t: '#2e9a92', b: '#3db4aa', m: '#7fe8df', p: '#a8f5ed', i: '#1b2029', k: '#0f171a',
        w: '#eafffb', r: '#ff6b5f', y: '#ffd166', d: '#26343d', x: 'transparent'
      };

      const concepts = [
        {
          n: '01', title: 'Cyclops Command', strong: true,
          note: 'Single-eye fluffy monster with tiny horns. Best balance of cute, sharp, and recognizable at favicon scale.',
          tags: ['single eye', 'favicon-safe', 'badass brow'],
          pattern: [
            'xxxxrrxxxxrrxxxx','xxxriixxxxiirxxx','xxrtiiittiiitrxx','xxttttttttttttxx','xttttttttttttttx','xttttwwwwwwttttx','ttttwkkkkkkwtttt','ttttwkmmmmkwtttt','ttttwkmppmkwtttt','xtttwkkkkkkwtttx','xttttwwwwwwttttx','xxttttttttttttxx','xxxtttttttttxxx','xxxxittxxittxxxx','xxxiiixxxiiixxx','xxxxxxxxxxxxxxxx'
          ]
        },
        {
          n: '02', title: 'Shield Fuzz',
          note: 'App-icon silhouette: fluffy shield body, one watchful lens, little feet. More logo than character.',
          tags: ['iconic shape', 'protective', 'clean'],
          pattern: [
            'xxxxmxxxxxxmxxxx','xxxmmxxxxxxmmxxx','xxmttmmmmmmttmxx','xxttttttttttttxx','xttttttttttttttx','xttttwwwwwwttttx','ttttwkkkkkkwtttt','ttttwkmpppkwtttt','ttttwkkkkkkwtttt','xttttwwwwwwttttx','xttttttttttttttx','xxttttttttttttxx','xxxxttttttttxxxx','xxxxxiixxiixxxxx','xxxxiiixxiiixxxx','xxxxxxxxxxxxxxxx'
          ]
        },
        {
          n: '03', title: 'Fluffy Orbit',
          note: 'Rounder mascot with antenna/orbit ears. Softer and friendly, with enough ink to stay technical.',
          tags: ['friendly', 'orbit ears', 'empty states'],
          pattern: [
            'xxxxxpxxxxpxxxxx','xxxxpxttttxpxxxx','xxxpxttttttxpxxx','xxxttttttttttxxx','xxttttttttttttxx','xtttwwttttwwtttx','xtttwkkttkkwtttx','ttttwkmttmkwtttt','ttttwkkttkkwtttt','xtttwwttttwwtttx','xttttttyyttttttx','xxtttttyytttttxx','xxxxttttttttxxxx','xxxxxiixxiixxxxx','xxxxxiixxiixxxxx','xxxxxxxxxxxxxxxx'
          ]
        },
        {
          n: '04', title: 'Branch Beast', strong: true,
          note: 'Monster body with a branching tail/horn motif: the most Agor-specific metaphor without showing git literally.',
          tags: ['branch cue', 'product-native', 'distinct'],
          pattern: [
            'xxxxxxmxxxxxxxxx','xxxxxmxxmxxxxxxx','xxxxmxxxxmxxxxxx','xxxmttttttmxxxxx','xxttttttttttxxxx','xtttwwttttwwtxxx','ttttwkkttkkwttxx','ttttwkmppmkwtttx','ttttwkkkkkkwtttx','xttttwwwwwwttttx','xxttttttttttttxx','xxxtttttttttmxxx','xxxxiittttmxmxxx','xxxiiixxxmxxxmxx','xxxxxxxxmxxxxxxx','xxxxxxxxxxxxxxxx'
          ]
        },
        {
          n: '05', title: 'Two-Eye Rascal',
          note: 'Classic two-eyed creature. High trust, expressive, but may be less ownable than the cyclops routes.',
          tags: ['expressive', 'approachable', 'safe'],
          pattern: [
            'xxxmxxxxxxxxmxxx','xxmmiixxxxiimmxx','xxtttiiiiittttxx','xttttttttttttttx','ttttwwttttwwtttt','ttttwkkttkkwtttt','ttttwkmttmkwtttt','ttttwkkttkkwtttt','ttttwwttttwwtttt','xttttttyyttttttx','xxtttttyytttttxx','xxxtttttttttxxx','xxxxiitxxiitxxxx','xxxiiixxxiiixxx','xxxxxxxxxxxxxxxx','xxxxxxxxxxxxxxxx'
          ]
        },
        {
          n: '06', title: 'Crowned Imp',
          note: 'Tiny mint crown/horns and a compact squat body. Feels confident and a bit mischievous.',
          tags: ['confident', 'compact', 'mischief'],
          pattern: [
            'xxxxpxxppxxpxxxx','xxxppxppppxppxxx','xxxtttttttttxxx','xxttttttttttttxx','xttttwwwwwwttttx','ttttwkkkkkkwtttt','ttttwkmpppkwtttt','ttttwkkkkkkwtttt','xttttwwwwwwttttx','xttttttyyttttttx','xxtttttyytttttxx','xxxxttttttttxxxx','xxxxxiixxiixxxxx','xxxxiiixxiiixxxx','xxxxxxxxxxxxxxxx','xxxxxxxxxxxxxxxx'
          ]
        },
        {
          n: '07', title: 'Terminal Gremlin', strong: true,
          note: 'Pixel monster with command prompt eyes. Very product-aware and less childish; strongest for developer audience.',
          tags: ['terminal', 'developer', 'sharp'],
          pattern: [
            'xxxrrxxxxxxrrxxx','xxriiixxxxiirxx','xxttttttttttttxx','xttttttttttttttx','ttttwwttttwwtttt','ttttwkkttkkwtttt','ttttwmmttmmwtttt','ttttwkpttkkwtttt','ttttwwttttwwtttt','xtttttkkkktttttx','xxttttyyyyttttxx','xxxtttttttttxxx','xxxxiitxxiitxxxx','xxxiiixxxiiixxx','xxxxxxxxxxxxxxxx','xxxxxxxxxxxxxxxx'
          ]
        },
        {
          n: '08', title: 'Soft Spike',
          note: 'Fluff-ball with small silhouette spikes. Friendly but still has an edge; good social-avatar candidate.',
          tags: ['fluffy', 'social', 'edge'],
          pattern: [
            'xxxxmxxmmxxmxxxx','xxxmmttttmmxxxxx','xxmttttttttmxxxx','xmttttttttttmxxx','ttttwwwwwwttttxx','ttttwkkkkkwttttx','ttttwkmmpkwttttx','ttttwkkkkkwttttx','ttttwwwwwwttttxx','xmttttttyyttmxxx','xxmttttyyttmxxxx','xxxmmttttmmxxxxx','xxxxiixxiixxxxxx','xxxiiixxiiixxxxx','xxxxxxxxxxxxxxxx','xxxxxxxxxxxxxxxx'
          ]
        },
        {
          n: '09', title: 'Agent Bat',
          note: 'Wing/ear silhouette nods to agents flying around the board. Fun, but riskier because bat cues can get spooky.',
          tags: ['motion', 'agent swarm', 'riskier'],
          pattern: [
            'xxmmxxxxxxxxmmxx','xmttmxxxxxxmttmx','mttttmxxxxmttttm','xxtttttmmtttttxx','xttttttttttttttx','ttttwwttttwwtttt','ttttwkkttkkwtttt','ttttwkmppkwttttt','ttttwkkkkkwttttt','xttttwwwwwtttttx','xxttttyyyttttxx','xxxxttttttttxxxx','xxxxxiixxiixxxxx','xxxxxxxxxxxxxxxx','xxxxxxxxxxxxxxxx','xxxxxxxxxxxxxxxx'
          ]
        },
        {
          n: '10', title: 'Portal Pup',
          note: 'Monster as a portal/window: big center eye in a rounded-square silhouette. Very app-icon friendly.',
          tags: ['app icon', 'portal', 'simple'],
          pattern: [
            'xxxxmmmmmmmmxxxx','xxxmttttttttmxxx','xxmttttttttttmxx','xxttttttttttttxx','xttttwwwwwwttttx','ttttwkkkkkkwtttt','ttttwkmmmmkwtttt','ttttwkmppmkwtttt','ttttwkkkkkkwtttt','xttttwwwwwwttttx','xxttttttttttttxx','xxmttttttttttmxx','xxxmttttttttmxxx','xxxxmmmmmmmmxxxx','xxxxxiixxiixxxxx','xxxxxxxxxxxxxxxx'
          ]
        },
        {
          n: '11', title: 'Spark Mote',
          note: 'Smallest, simplest sprite with asymmetric sparks. Could animate well, but may lack mascot personality.',
          tags: ['tiny', 'animated', 'minimal'],
          pattern: [
            'xxxxxxxxpxxxxxxx','xxxxxpxxpxxxxxxx','xxxxxxpptxxxxxxx','xxxxxxttttxxxxxx','xxxxxttttttxxxxx','xxxxttwwwwttxxxx','xxxxttwkkwttxxxx','xxxxttwmmwttxxxx','xxxxttwkkwttxxxx','xxxxttwwwwttxxxx','xxxxxttyyttxxxxx','xxxxxxttttxxxxxx','xxxxxxxiixxxxxxx','xxxxxxxxxxxxxxxx','xxxxxxxxxxxxxxxx','xxxxxxxxxxxxxxxx'
          ]
        },
        {
          n: '12', title: 'Board Bruiser',
          note: 'Wide, grounded creature with card-like proportions. Reads like a branch card mascot; maybe too horizontal for favicon.',
          tags: ['board card', 'grounded', 'wide'],
          pattern: [
            'xxxxxxxxxxxxxxxx','xxxxmxxxxxxmxxxx','xxxmttttttttmxxx','xxmttttttttttmxx','xmttwwttttwwttmx','ttttwkkttkkwtttt','ttttwkmttmkwtttt','ttttwkkttkkwtttt','xmttwwttttwwttmx','xxmttttkkkkttmxx','xxxmtttyyyttmxxx','xxxxmttttttmxxxx','xxxiiixxxiiixxx','xxxxxxxxxxxxxxxx','xxxxxxxxxxxxxxxx','xxxxxxxxxxxxxxxx'
          ]
        }
      ];

      function svgFromPattern(pattern, label) {
        const size = 16;
        const scale = 8;
        const rects = [];
        pattern.forEach((row, y) => [...row].forEach((cell, x) => {
          if (cell === 'x') return;
          rects.push(`<rect x="${x * scale}" y="${y * scale}" width="${scale}" height="${scale}" fill="${colors[cell] || colors.t}"/>`);
        }));
        return `<svg class="pixel-mark" viewBox="0 0 ${size * scale} ${size * scale}" role="img" aria-label="${label}" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg"><title>${label}</title>${rects.join('')}</svg>`;
      }

      const grid = document.querySelector('#concepts');
      grid.innerHTML = concepts.map((c) => `
        <article class="card ${c.strong ? 'strong' : ''}">
          <div class="mark-stage">${svgFromPattern(c.pattern, c.title)}</div>
          <div class="small-row">${svgFromPattern(c.pattern, `${c.title} 32px preview`)}<span class="wordmark">agor</span></div>
          <h3>${c.n} · ${c.title}</h3>
          <p>${c.note}</p>
          <div class="tagline">${c.tags.map((tag) => `<span>${tag}</span>`).join('')}</div>
        </article>
      `).join('');
