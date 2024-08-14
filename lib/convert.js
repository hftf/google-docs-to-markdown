import fixGoogleHtml from './fix-google-html.js';
// rehype-dom-parse is a lightweight version of rehype-parse that leverages
// browser APIs -- reduces bundle size by ~200 kB!
import parse from 'rehype-dom-parse';
import { defaultHandlers } from 'hast-util-to-mdast';
import rehype2remarkWithSpaces from './rehype-to-remark-with-spaces.js';
import remarkGfm from 'remark-gfm';
import stringify from 'remark-stringify';
import { unified } from 'unified';
// import logTree from './log-tree.js';

/** @typedef {import("mdast-util-to-markdown").State} MdastState */
/** @typedef {import("unist").Node} UnistNode */
/** @typedef {import("hast-util-to-mdast").Handle} Handle */

export const defaultOptions = {
  // TODO: the headings options are not hooked up yet.
  headingIdValue: 'text',
  headingIdSyntax: 'html',
  suggestions: 'show',
};

/** @type {Handle} */
function preserveTagAndConvertContents(state, node, _parent) {
  return [
    { type: 'html', value: `<${node.tagName}>` },
    ...state.all(node),
    { type: 'html', value: `</${node.tagName}>` },
  ];
}

/** @type {Handle} */
function preserveU(state, node, _parent) {
  return [
    { type: 'underline', children: state.all(node) },
  ];
}

/** @type {Handle} */
function headingWithId(state, node, _parent) {
  const newNode = defaultHandlers[node.tagName](state, node);

  if (node.properties?.id) {
    newNode.children?.push({
      type: 'html',
      value: `<a id="${node.properties.id}"></a>`,
    });
  }

  return newNode;
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

const processor = unified()
  .use(parse)
  .use(fixGoogleHtml)
  // .use(logTree)
  .use(rehype2remarkWithSpaces, {
    handlers: {
      // Preserve sup/sub markup; most Markdowns have no markup for it.
      sub: preserveTagAndConvertContents,
      sup: preserveTagAndConvertContents,
      ins: preserveTagAndConvertContents,
      u: preserveU,
      h1: headingWithId,
      h2: headingWithId,
      h3: headingWithId,
      h4: headingWithId,
      h5: headingWithId,
      h6: headingWithId,

      // The default `<a>` handler swallows link *targets*. We need to preserve
      // them so bookmarks for intra-document links work.
      a(state, node, _parent) {
        const anchorName = node.properties.id || node.properties.name;
        if (anchorName && !node.properties.href) {
          return [{ type: 'html', value: `<a id="${anchorName}"></a>` }];
        } else {
          return defaultHandlers['a'](state, node);
        }
      },
    },
  })
  .use(remarkGfm)
  .use(stringify, {
    bullet: '-',
    emphasis: '*',
    fences: false,
    listItemIndent: 'one',
    strong: '*',
    join: [doubleBlankLinesBeforeHeadings],
  });

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

export function convertDocsHtmlToMarkdown(html, rawSliceClip, options) {
  const sliceClip = rawSliceClip ? parseGdocsSliceClip(rawSliceClip) : null;
  return processor
    .process({
      value: html,
      data: {
        sliceClip,
        options: { ...defaultOptions, ...options },
      },
    })
    .then((result) => {
		let value = result.value.replaceAll('\n\n','\n').replaceAll(/\\(?=[<[.])/gm, '')
		return options.spoiler ? addSpoilerTags(value) : value
	});
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

		result = value.replaceAll(/^(\\?\[10\] |ANSWER: )(.*)/gm, '$1||$2||') + `\n||${partDifficulties.join('/')}||\n!t`
	}
	else {
		let regex = /(?<=[.!?][”’"']?)\s/gm
		result = value.replaceAll(/^(\d+\\?\.\s)?([^\n]+)(\n^ANSWER: )([^\n]*)(\n.*)?/gm,
			(_, a, b, c, d, e) => `${a}||${b.split(regex).join(`|| ||`)}||${c}||${d}||${e}\n!t`)
	}

	return result
}

var testTossup = `This is the first sentence of the tossup. “This is the second sentence of the tossup.” The third line of this tossup, like any of the others, could be split up into multiple spoiler-tagged sections. The fourth line of the tossup is almost the end. For 10 points, what is the answer to this tossup?
ANSWER: answer
<XY, Category>`;
var testTossupExpected = `||This is the first sentence of the tossup.|| ||“This is the second sentence of the tossup.”|| ||The third line of this tossup,|| ||like any of the others,|| ||could be split up into multiple spoiler-tagged sections.|| ||The fourth line of the tossup is almost the end.|| ||For 10 points, what is the answer to this tossup?||
ANSWER: ||answer||
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
ANSWER: ||easy answerline||
[10] ||This is an example of a medium part.||
ANSWER: ||medium answerline||
[10] ||This is an example of a hard part.||
ANSWER: ||hard answerline||
<XY, Category>
||e/m/h||
!t`;
console.log(addSpoilerTags(testTossup) === testTossupExpected);
console.log(addSpoilerTags(testBonus) === testBonusExpected);
