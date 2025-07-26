// rehype-dom-parse is a lightweight version of rehype-parse that leverages
// browser APIs -- reduces bundle size by ~200 kB!
import parse from 'rehype-dom-parse';
import { defaultHandlers } from 'hast-util-to-mdast';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import stringify from 'remark-stringify';
import { unified } from 'unified';
import GithubSlugger from 'github-slugger';
import { updateHtmlWithSliceClip, cleanGoogleHtml } from './fix-google-html.js';
import { getHastTextContent } from './hast-tools.js';
// import logTree from './log-tree.js';
import rehype2remarkWithSpaces from './rehype-to-remark-with-spaces.js';

/** @typedef {import("mdast-util-to-markdown").State} MdastState */
/** @typedef {import("unist").Node} UnistNode */
/** @typedef {import("hast-util-to-mdast").Handle} Handle */

export const defaultOptions = {
  codeBlocks: 'indented',
  headingIds: 'hidden',
  suggestions: 'show',
  underline: 'underscore',
  linebreaking: 'one',
};
const pad = '	'.repeat(5)

/** @type {Handle} */
function preserveTagAndConvertContents(state, node, _parent) {
  return [
    { type: 'html', value: `<${node.tagName}>` },
    ...state.all(node),
    { type: 'html', value: `</${node.tagName}>` },
  ];
}

function underlineHandler({ underline }) {
    return (underline === 'html') ? preserveTagAndConvertContents : preserveU;
}

/** @type {Handle} */
function preserveU(state, node, _parent) {
  return [
    { type: 'underline', children: state.all(node) },
  ];
}

/**
 * Adds support for marking up a heading's ID in various formats.
 * @param {object} options
 * @returns {Handle}
 */
function headingWithIdHandler({ headingIds }) {
  /** @type {Handle} */
  return function headingToMdast(state, node, _parent) {
    const newNode = defaultHandlers[node.tagName](state, node);

    if (node.properties?.id) {
      let idCode = '';
      if (headingIds === 'html') {
        idCode = `<a id="${node.properties.id}"></a>`;
      } else if (headingIds === 'extended') {
        idCode = ` {#${node.properties.id}}`;
      }

      newNode.children?.push({
        type: 'html',
        value: idCode,
      });
    }

    return newNode;
  };
}

/**
 * Create a handler for `<a>` elements. The default handler is pretty basic,
 * and this adds support for linking to headings by slug (instead of ID) and
 * for bookmarks (anchors that are the target of other links in the doc).
 * @param {object} options
 * @returns {Handle}
 */
function anchorHandler({ headingIds }) {
  const slugger = new GithubSlugger();

  /** @type {Handle} */
  return function anchorToMdast(state, node, _parent) {
    const anchorName = node.properties.id || node.properties.name;
    if (anchorName && !node.properties.href) {
      // The default handler does not preserve anchors that are targets, but we
      // need them to implement bookmarks from Google Docs.
      return [{ type: 'html', value: `<a id="${anchorName}"></a>` }];
    } else {
      // Links to headings
      let href = node.properties.href;
      if (href?.startsWith('#')) {
        const target = state.elementById.get(href.slice(1));
        if (target && /^h\d$/.test(target.tagName) && headingIds === 'hidden') {
          const headingSlug = slugger.slug(getHastTextContent(target));
          node.properties.href = `#${headingSlug}`;
        }
      }

      return defaultHandlers['a'](state, node);
    }
  };
}

/**
 * Use two blank lines before headings. This is a "join" function, which tells
 * remark-stringify how to join adjacent nodes.
 * @param {UnistNode} previous
 * @param {UnistNode} next
 * @param {UnistNode} _parent
 * @param {MdastState} _state
 * @returns {boolean|number|void}
 */
function doubleBlankLinesBeforeHeadings(previous, next, _parent, _state) {
  if (previous.type !== 'heading' && next.type === 'heading') {
    return 2;
  }
  return undefined;
}

function createProcessor(options, converter = cleanGoogleHtml) {
  const headingWithId = headingWithIdHandler(options);

  return unified()
    .use(parse)
    .use(converter)
    .use(rehype2remarkWithSpaces, {
      handlers: {
        // Preserve sup/sub markup; most Markdowns have no markup for it.
        sub: preserveTagAndConvertContents,
        sup: preserveTagAndConvertContents,
        ins: preserveTagAndConvertContents,
        u: underlineHandler(options),
        h1: headingWithId,
        h2: headingWithId,
        h3: headingWithId,
        h4: headingWithId,
        h5: headingWithId,
        h6: headingWithId,
        a: anchorHandler(options),
      },
    })
    .use(remarkGfm)
    .use(stringify, {
      bullet: '-',
      emphasis: '_',
      fences: options.codeBlocks === 'fenced',
      listItemIndent: 'one',
      strong: '*',
      join: [doubleBlankLinesBeforeHeadings],
    });
}

/**
 * Parse a Google Docs Slice Clip (the Google Docs internal format for
 * representing copied documents or selections from a document). This parses a
 * string representing the document and unwraps it if enclosed in a wrapper
 * object. You can pass in a string or object.
 * @param {any} raw
 * @returns {any}
 */
function parseGdocsSliceClip(raw) {
  const wrapper = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const data =
    typeof wrapper.data === 'string' ? JSON.parse(wrapper.data) : wrapper.data;

  // Do a basic check to ensure we are dealing with what we think we are. This
  // is not meant to be exhaustive or to check the exact schema.
  if (
    typeof data?.resolved?.dsl_entitypositionmap !== 'object' ||
    typeof data?.resolved?.dsl_spacers !== 'string' ||
    !Array.isArray(data?.resolved?.dsl_styleslices)
  ) {
    throw new SyntaxError(
      `Document does not appear to be a GDocs Slice Clip: ${JSON.stringify(
        raw
      )}`
    );
  }

  return data;
}

export async function convertDocsHtmlToMarkdown(html, rawSliceClip, options) {
  options = { ...defaultOptions, ...options };

  if (rawSliceClip) {
    html = await combineGoogleDocFormats(html, rawSliceClip);
  }

  const result = await createProcessor(options, cleanGoogleHtml).process({
    value: html,
    data: { options },
  })
  .then((result) => {
    let value = result.value;

    if (options.spoiler)
        value = addSpoilerTags(value)

    // remove backslash before brackets and periods (over-escaping)
    value = value.replaceAll(/\\(?=[<[.])/gm, '')

    if (options.linebreaking === 'one')
        value = value.replaceAll('\n\n','\n');
    else if (options.linebreaking === 'backslash')
        value = value.replaceAll('\n\n','\\\n');

    result.value = value;
    return result;
  });

  return result.value;
}

export async function combineGoogleDocFormats(html, rawSliceClip) {
  const sliceClip = rawSliceClip ? parseGdocsSliceClip(rawSliceClip) : null;

  const result = await unified()
    .use(parse)
    .use(updateHtmlWithSliceClip)
    .use(rehypeStringify)
    .process({ value: html, data: { sliceClip } });

  return result.value;
}

function addSpoilerTags(value) {
    let result = ''
    let isBonus = value.includes('[10')
    if (isBonus) {
        // extract letters after [10 into string and join with /
        let regex = /(?<=^\\?\[10)[emh]/gm
        let partDifficulties = []
        value = value.replaceAll(regex, (match) => {
            partDifficulties.push(match)
            return ''
        })
        let first = true
        result = value.replaceAll(/^(\\?\[10\] )(.*)/gm, (match, p1, p2) => {
            if (first) {
                first = false
                return match
            }
            return `${p1}||${p2}||`
        })
        result = result.replaceAll(/^(ANSWER: )(.*)/gm,   `$1||$2${pad}||`) + `\n||${partDifficulties.join('/')}||\n!t`
    }
    else {
        let regex = /(?<=[.!?][”’"']?)\s/gm
        result = value.replaceAll(/^(\d+\\?\.\s)?([^\n]+\n*)(\n^ANSWER: )([^\n]*)(\n.*)?/gm,
            (_, a, b, c, d, e) => `${a || ''}||${b.split(regex).join(`|| ||`)}||${c}||${d}${pad}||${e}\n!t`)
    }

    return result
}

var testTossup = `This is the first sentence of the tossup. “This is the second sentence of the tossup.” The third line of this tossup, like any of the others, could be split up into multiple spoiler-tagged sections. The fourth line of the tossup is almost the end. For 10 points, what is the answer to this tossup?
ANSWER: answer
<XY, Category>`;
var testTossupExpected = `||This is the first sentence of the tossup.|| ||“This is the second sentence of the tossup.”|| ||The third line of this tossup, like any of the others, could be split up into multiple spoiler-tagged sections.|| ||The fourth line of the tossup is almost the end.|| ||For 10 points, what is the answer to this tossup?||
ANSWER: ||answer${pad}||
<XY, Category>
!t`;
var testBonus = `This is an example of a bonus leadin. For 10 points each:
[10e] This is an example of an easy part.
ANSWER: easy answerline
[10m] This is an example of a medium part.
ANSWER: medium answerline
[10h] This is an example of a hard part.
ANSWER: hard answerline
<XY, Category>`;
var testBonusExpected = `This is an example of a bonus leadin. For 10 points each:
[10] This is an example of an easy part.
ANSWER: ||easy answerline${pad}||
[10] ||This is an example of a medium part.||
ANSWER: ||medium answerline${pad}||
[10] ||This is an example of a hard part.||
ANSWER: ||hard answerline${pad}||
<XY, Category>
||e/m/h||
!t`;
console.log(addSpoilerTags(testTossup) === testTossupExpected);
console.log(addSpoilerTags(testBonus) === testBonusExpected);
