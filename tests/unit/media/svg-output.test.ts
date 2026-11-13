import { expect, test } from 'bun:test';
import { privateMediaHeaders } from '../../../src/lib/server/media/files';
import { assertSafeSvg, isSvgPrefix } from '../../../src/lib/server/media/svg-output';

test('recognizes SVG XML and comments, preserving local gradient and use references', () => {
  const svg =
    '<?xml version="1.0"?>\n<!-- generated -->\n<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"/></defs><path fill="url(#g)" d="M0 0"/><use href="#g"/></svg>';
  expect(isSvgPrefix(new TextEncoder().encode(svg))).toBe(true);
  expect(() => assertSafeSvg(svg)).not.toThrow();
  expect(isSvgPrefix(new TextEncoder().encode('<html><svg></svg></html>'))).toBe(false);
});

test.each([
  '<svg><script>alert(1)</script></svg>',
  '<svg><g></svg>',
  '<svg><style>path{fill:red}</style><path/></svg>',
  '<svg><path style="fill:red"/></svg>',
  '<svg xmlns="http://www.w3.org/1999/xhtml"><img srcset="https://external.example/x.png"/></svg>',
  '<svg style="background-image:image-set(&quot;https://external.example/x.png&quot; 1x)"><path/></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg" xml:base="https://external.example/image.svg"><use href="#p"/></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg" xmlns:é="http://www.w3.org/2000/svg"><é:script>alert(1)</é:script></svg>',
  '<svg><style>@\\69mport "https://external.example/style.css";</style></svg>',
  '<svg><path style="fill:u\\72l(https://external.example/x.svg#p)"/></svg>',
  '<svg><path style="fill:u&#114;l(https://external.example/x.svg#p)"/></svg>',
  '<svg onload="alert(1)"></svg>',
  '<svg><foreignObject><html/></foreignObject></svg>',
  '<svg><image href="http://127.0.0.1/private"/></svg>',
  '<svg><use href="&#106;avascript:alert(1)"/></svg>',
  '<svg><style>path{fill:url(https://private.example)}</style></svg>',
  '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>',
  '<svg><animate attributeName="href" to="javascript:alert(1)"/></svg>',
  '<svg><path/>'
])('rejects active, external and incomplete SVG: %s', (svg) => {
  expect(() => assertSafeSvg(svg)).toThrow();
});

test('SVG responses sandbox direct navigation and forbid subresource requests', () => {
  const headers = privateMediaHeaders('image/svg+xml', 100);
  expect(headers.get('content-security-policy')).toContain('sandbox;');
  expect(headers.get('content-security-policy')).toContain("default-src 'none'");
  expect(headers.get('content-security-policy')).toContain("img-src 'none'");
  expect(headers.get('x-content-type-options')).toBe('nosniff');
});
