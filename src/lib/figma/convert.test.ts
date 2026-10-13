import { describe, it, expect } from "vitest";
import { convertNode } from "./convert";
import type { FigmaNode } from "./types";

const box = (w: number, h: number, x = 0, y = 0) => ({ x, y, width: w, height: h });

function frame(props: Partial<FigmaNode>): FigmaNode {
  return {
    id: "1:1",
    name: "Frame",
    type: "FRAME",
    absoluteBoundingBox: box(100, 100),
    ...props,
  } as FigmaNode;
}

describe("converter: visual fidelity", () => {
  it("derives the linear-gradient angle in pixel space, not handle space", () => {
    // Handles run corner-to-corner of a 200x100 box: 45° in normalised handle
    // space, but ~63.4° on screen.
    const n = frame({
      absoluteBoundingBox: box(200, 100),
      fills: [
        {
          type: "GRADIENT_LINEAR",
          gradientHandlePositions: [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
          ],
          gradientStops: [
            { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
            { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
          ],
        },
      ],
    });
    const m = /linear-gradient\((\d+(?:\.\d+)?)deg/.exec(convertNode(n).html);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBeCloseTo(116.57, 0);
  });

  it("remaps stop offsets onto the CSS gradient line", () => {
    // A horizontal gradient covering only the middle half of the box must keep
    // that extent — CSS would otherwise stretch it edge to edge.
    const n = frame({
      absoluteBoundingBox: box(100, 100),
      fills: [
        {
          type: "GRADIENT_LINEAR",
          gradientHandlePositions: [
            { x: 0.25, y: 0.5 },
            { x: 0.75, y: 0.5 },
          ],
          gradientStops: [
            { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
            { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
          ],
        },
      ],
    });
    const html = convertNode(n).html;
    expect(html).toContain("linear-gradient(90deg");
    expect(html).toContain("25%");
    expect(html).toContain("75%");
  });

  it("folds the paint opacity into the gradient stops", () => {
    const n = frame({
      fills: [
        {
          type: "GRADIENT_LINEAR",
          opacity: 0.5,
          gradientAngle: 180,
          gradientStops: [
            { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
            { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
          ],
        },
      ],
    });
    expect(convertNode(n).html).toContain("rgba(255,0,0,0.5)");
  });

  it("scales radial radii per axis on a non-square box", () => {
    const n = frame({
      absoluteBoundingBox: box(200, 100),
      fills: [
        {
          type: "GRADIENT_RADIAL",
          gradientHandlePositions: [
            { x: 0.5, y: 0.5 },
            { x: 1, y: 0.5 },
            { x: 0.5, y: 1 },
          ],
          gradientStops: [
            { position: 0, color: { r: 1, g: 1, b: 1, a: 1 } },
            { position: 1, color: { r: 0, g: 0, b: 0, a: 1 } },
          ],
        },
      ],
    });
    expect(convertNode(n).html).toContain("radial-gradient(ellipse 50% 50% at 50% 50%");
  });

  it("clips a gradient text fill to the glyphs", () => {
    const n = {
      id: "1:2",
      name: "Title",
      type: "TEXT",
      characters: "Hi",
      absoluteBoundingBox: box(100, 20),
      fills: [
        {
          type: "GRADIENT_LINEAR",
          gradientAngle: 90,
          gradientStops: [
            { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
            { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
          ],
        },
      ],
    } as unknown as FigmaNode;
    const html = convertNode(n).html;
    expect(html).toContain("bg-clip-text");
    expect(html).toContain("text-transparent");
    expect(html).toContain("linear-gradient(");
  });

  it("paints a gradient stroke with border-image", () => {
    const n = frame({
      strokeWeight: 2,
      strokes: [
        {
          type: "GRADIENT_LINEAR",
          gradientAngle: 90,
          gradientStops: [
            { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
            { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
          ],
        },
      ],
    });
    const html = convertNode(n).html;
    expect(html).toContain("border-image");
    expect(html).toContain("2px solid transparent");
  });

  it("uses the real gradient angle from the plugin", () => {
    const n = frame({
      fills: [
        {
          type: "GRADIENT_LINEAR",
          gradientAngle: 90,
          gradientStops: [
            { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
            { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
          ],
        },
      ],
    });
    expect(convertNode(n).html).toContain("linear-gradient(90deg");
  });

  it("positions a radial gradient from its handles", () => {
    const n = frame({
      fills: [
        {
          type: "GRADIENT_RADIAL",
          gradientHandlePositions: [
            { x: 0.5, y: 0.5 },
            { x: 1, y: 0.5 },
            { x: 0.5, y: 1 },
          ],
          gradientStops: [
            { position: 0, color: { r: 1, g: 1, b: 1, a: 1 } },
            { position: 1, color: { r: 0, g: 0, b: 0, a: 1 } },
          ],
        },
      ],
    });
    expect(convertNode(n).html).toContain("radial-gradient(ellipse 50% 50% at 50% 50%");
  });

  it("stacks a gradient over a solid fill as layered backgrounds", () => {
    const n = frame({
      fills: [
        { type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } },
        {
          type: "GRADIENT_LINEAR",
          gradientAngle: 0,
          gradientStops: [
            { position: 0, color: { r: 1, g: 0, b: 0, a: 0.5 } },
            { position: 1, color: { r: 0, g: 0, b: 1, a: 0.5 } },
          ],
        },
      ],
    });
    const { html } = convertNode(n);
    // gradient (top) listed before the flattened solid (bottom)
    expect(html).toContain("linear-gradient(0deg,");
    expect(html).toMatch(/,\s*linear-gradient\(#000000,#000000\)/);
  });

  it("emits rotation, layer blur and backdrop blur", () => {
    const n = frame({
      rotation: 15,
      effects: [
        { type: "LAYER_BLUR", radius: 4 },
        { type: "BACKGROUND_BLUR", radius: 8 },
      ],
    });
    const { code } = convertNode(n);
    expect(code).toContain("rotate-[15deg]");
    expect(code).toContain("blur-[4px]");
    expect(code).toContain("backdrop-blur-[8px]");
  });

  it("joins multiple shadows into one box-shadow utility", () => {
    const n = frame({
      effects: [
        { type: "DROP_SHADOW", offset: { x: 0, y: 2 }, radius: 4, color: { r: 0, g: 0, b: 0, a: 0.2 } },
        { type: "DROP_SHADOW", offset: { x: 0, y: 8 }, radius: 16, color: { r: 0, g: 0, b: 0, a: 0.1 } },
      ],
    });
    const shadowClass = /shadow-\[([^\]]+)\]/.exec(convertNode(n).code)?.[1] ?? "";
    // Two distinct shadows, each keyed by its y-offset.
    expect(shadowClass).toContain("0px_2px_4px");
    expect(shadowClass).toContain("0px_8px_16px");
  });

  it("uses an outline (not a border) for an OUTSIDE stroke", () => {
    const n = frame({
      strokeWeight: 2,
      strokeAlign: "OUTSIDE",
      strokes: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    const { code } = convertNode(n);
    expect(code).toContain("outline");
    expect(code).not.toContain("border-[2px]");
  });
});

describe("converter: design-system variables", () => {
  it("emits a bound color variable as a semantic token class", () => {
    const n = frame({
      fills: [{ type: "SOLID", color: { r: 0.48, g: 0.42, b: 1, a: 1 }, variableName: "primary-500" }],
    });
    const opts = {
      absolutePositioning: true,
      useTokens: true,
      variables: [{ name: "primary-500", kind: "color" as const, value: "#7c6cff" }],
    };
    const { code, themeCss } = convertNode(n, opts);
    expect(code).toContain("bg-primary-500");
    expect(themeCss).toContain("--color-primary-500");
  });

  it("emits bound spacing variables as gap/padding tokens", () => {
    const n = frame({
      layoutMode: "HORIZONTAL",
      itemSpacing: 16,
      itemSpacingVar: "md",
      paddingLeft: 24,
      paddingLeftVar: "lg",
      children: [],
    });
    const { code } = convertNode(n, {
      absolutePositioning: true,
      useTokens: true,
      variables: [
        { name: "md", kind: "space", value: "16px" },
        { name: "lg", kind: "space", value: "24px" },
      ],
    });
    expect(code).toContain("gap-md");
    expect(code).toContain("pl-lg");
  });
});

describe("converter: flex sizing fidelity", () => {
  const row = (children: FigmaNode[]): FigmaNode =>
    frame({
      id: "row",
      layoutMode: "HORIZONTAL",
      absoluteBoundingBox: box(300, 40),
      children,
    });

  it("pins a fixed-size flex child with shrink-0 so it doesn't squish", () => {
    const child = frame({
      id: "c",
      layoutSizingHorizontal: "FIXED",
      absoluteBoundingBox: box(80, 40),
    });
    const { code } = convertNode(row([child]));
    // The fixed child must hold its width when the row narrows.
    const childClasses = /w-\[80px\][^"]*/.exec(code)?.[0] ?? code;
    expect(code).toContain("shrink-0");
    expect(childClasses).toBeTruthy();
  });

  it("does not add shrink-0 to a Fill child (it should grow)", () => {
    const child = frame({
      id: "c",
      layoutSizingHorizontal: "FILL",
      layoutGrow: 1,
      absoluteBoundingBox: box(80, 40),
    });
    const { code } = convertNode(row([child]));
    expect(code).toContain("grow");
    // The grow child is the only child; the row itself may be shrink-free.
    const growLine = code.split("\n").find((l) => l.includes("grow")) ?? "";
    expect(growLine).not.toContain("shrink-0");
  });
});

describe("converter: constraints → responsive pins", () => {
  const parent = (child: FigmaNode): FigmaNode =>
    frame({
      id: "p",
      absoluteBoundingBox: box(200, 200),
      children: [child],
    });

  it("pins a MAX-constrained child to the right", () => {
    const child = frame({
      id: "c",
      absoluteBoundingBox: box(40, 20, 150, 10),
      constraints: { horizontal: "MAX", vertical: "MIN" },
    });
    const { html } = convertNode(parent(child));
    expect(html).toContain("right-[10px]");
  });

  it("stretches a LEFT_RIGHT child and drops its fixed width", () => {
    const child = frame({
      id: "c",
      absoluteBoundingBox: box(180, 20, 10, 10),
      constraints: { horizontal: "STRETCH", vertical: "MIN" },
    });
    const { html } = convertNode(parent(child));
    expect(html).toContain("left-[10px]");
    expect(html).toContain("right-[10px]");
    expect(html).not.toContain("w-[180px]");
  });
});

describe("converter: mixed text + background photo", () => {
  it("splits mixed text into styled spans", () => {
    const n: FigmaNode = {
      id: "t",
      name: "Text",
      type: "TEXT",
      absoluteBoundingBox: box(200, 20),
      characters: "Hello world",
      style: { fontSize: 16, fontWeight: 400 },
      styledSegments: [
        { characters: "Hello ", fontWeight: 400 },
        { characters: "world", fontWeight: 700 },
      ],
    } as FigmaNode;
    const { html } = convertNode(n);
    expect(html).toContain("<span");
    expect(html).toContain("font-[700]");
  });

  it("registers a background-image asset for a photo container", () => {
    const n = frame({
      fills: [{ type: "IMAGE", scaleMode: "FILL", imageRef: "abc" }],
      children: [frame({ id: "c", absoluteBoundingBox: box(20, 20) })],
    });
    const { html, assets } = convertNode(n);
    expect(html).toContain("url(@@ASSET:1:1@@)");
    expect(assets.some((a) => a.id === "1:1")).toBe(true);
  });
});

describe("converter: image scaleMode", () => {
  it("uses bg-contain for a FIT background photo", () => {
    const n = frame({
      fills: [{ type: "IMAGE", scaleMode: "FIT", imageRef: "abc" }],
      children: [frame({ id: "c", absoluteBoundingBox: box(20, 20) })],
    });
    const { html } = convertNode(n);
    expect(html).toContain("bg-contain");
    expect(html).not.toContain("bg-cover");
  });

  it("tiles a TILE background photo", () => {
    const n = frame({
      fills: [{ type: "IMAGE", scaleMode: "TILE", imageRef: "abc" }],
      children: [frame({ id: "c", absoluteBoundingBox: box(20, 20) })],
    });
    expect(convertNode(n).html).toContain("bg-repeat");
  });

  it("uses object-contain for a FIT image leaf", () => {
    const n = frame({ fills: [{ type: "IMAGE", scaleMode: "FIT", imageRef: "abc" }] });
    expect(convertNode(n).html).toContain("object-contain");
  });

  it("keeps the photo of a card that also has a gradient overlay", () => {
    const n = frame({
      fills: [
        { type: "IMAGE", scaleMode: "FILL", imageRef: "abc" },
        {
          type: "GRADIENT_LINEAR",
          gradientHandlePositions: [{ x: 0.5, y: 0 }, { x: 0.5, y: 1 }, { x: 0, y: 0 }],
          gradientStops: [
            { position: 0, color: { r: 0, g: 0, b: 0, a: 0.5 } },
            { position: 1, color: { r: 0, g: 0, b: 0, a: 0 } },
          ],
        },
      ],
      children: [frame({ id: "c", absoluteBoundingBox: box(20, 20) })],
    });
    const { html } = convertNode(n);
    expect(html).toContain("background-image");
    expect(html).not.toContain("linear-gradient");
  });

  it("pushes absolute backdrop layers below the in-flow content", () => {
    const n = frame({
      layoutMode: "VERTICAL",
      absoluteBoundingBox: box(400, 400),
      children: [
        frame({ id: "glow", layoutPositioning: "ABSOLUTE", absoluteBoundingBox: box(400, 400) }),
        frame({ id: "content", absoluteBoundingBox: box(400, 100) }),
        frame({ id: "badge", layoutPositioning: "ABSOLUTE", absoluteBoundingBox: box(20, 20) }),
      ],
    });
    const html = convertNode(n).html;
    expect(html).toContain("isolate");
    expect(html.match(/-z-10/g)?.length).toBe(1); // the glow, not the badge on top
  });

  it("stretches a fixed child that spans its column parent", () => {
    const n = frame({
      layoutMode: "VERTICAL",
      absoluteBoundingBox: box(1360, 600),
      children: [frame({ id: "row", layoutMode: "HORIZONTAL", absoluteBoundingBox: box(1360, 300) })],
    });
    const html = convertNode(n).html;
    expect(html.match(/w-\[1360px\]/g)?.length).toBe(1); // the root only
    expect(html).toContain("w-full");
  });

  it("sizes an exported vector logo even when it hugs its contents", () => {
    const n = frame({
      layoutMode: "HORIZONTAL",
      children: [
        {
          id: "logo",
          name: "logo",
          type: "FRAME",
          layoutSizingHorizontal: "HUG",
          layoutSizingVertical: "HUG",
          absoluteBoundingBox: box(112, 24),
          children: [{ id: "lv", name: "v", type: "VECTOR", absoluteBoundingBox: box(112, 24) }],
        } as FigmaNode,
      ],
    });
    const html = convertNode(n).html;
    expect(html).toContain("w-[112px]");
    expect(html).toContain("h-[24px]");
  });
});

describe("converter: prototype reactions → links/buttons", () => {
  it("emits a real <a href> from an OPEN_URL reaction", () => {
    const n = frame({ name: "Card", href: "https://example.com" });
    const { code } = convertNode(n, { absolutePositioning: true, semantic: true });
    expect(code).toContain('<a');
    expect(code).toContain('href="https://example.com"');
  });

  it("emits a <button> from a clickable reaction", () => {
    const n = frame({
      name: "Card",
      clickable: true,
      layoutMode: "HORIZONTAL",
      children: [
        { id: "t", name: "t", type: "TEXT", characters: "Go", style: { fontSize: 14 } } as FigmaNode,
      ],
    });
    const { code } = convertNode(n, { absolutePositioning: true, semantic: true });
    expect(code).toContain("<button");
  });
});

describe("converter: auto-layout min/max sizing", () => {
  it("emits max-w / min-w utilities", () => {
    const n = frame({ maxWidth: 640, minHeight: 120 });
    const { code } = convertNode(n);
    expect(code).toContain("max-w-[640px]");
    expect(code).toContain("min-h-[120px]");
  });
});

describe("converter: text truncation", () => {
  const textNode = (props: Partial<FigmaNode>): FigmaNode =>
    ({
      id: "t",
      name: "Text",
      type: "TEXT",
      absoluteBoundingBox: box(200, 20),
      characters: "Hello world",
      style: { fontSize: 16 },
      ...props,
    }) as FigmaNode;

  it("uses truncate for single-line ending truncation", () => {
    const { code } = convertNode(textNode({ textTruncate: "ENDING" }));
    expect(code).toContain("truncate");
  });

  it("uses line-clamp-N for multi-line truncation", () => {
    const { code } = convertNode(textNode({ textTruncate: "ENDING", maxLines: 3 }));
    expect(code).toContain("line-clamp-3");
  });
});

describe("converter: component TEXT properties → props", () => {
  it("generates typed props and binds a text node to {prop}", () => {
    const n = frame({
      name: "Button",
      componentName: "Button",
      componentProperties: { "Label#8:0": { type: "TEXT", value: "Click me" } },
      children: [
        {
          id: "t",
          name: "Label",
          type: "TEXT",
          absoluteBoundingBox: box(80, 20),
          characters: "Click me",
          style: { fontSize: 14 },
          textProp: "Label#8:0",
        } as FigmaNode,
      ],
    });
    const { code } = convertNode(n);
    expect(code).toContain("interface ButtonProps");
    expect(code).toContain("label?: string");
    expect(code).toContain('label = "Click me"');
    expect(code).toContain("{label}");
  });

  it("leaves HTML output with the literal text (no prop expression)", () => {
    const n = frame({
      name: "Button",
      componentProperties: { "Label#8:0": { type: "TEXT", value: "Click me" } },
      children: [
        {
          id: "t",
          name: "Label",
          type: "TEXT",
          absoluteBoundingBox: box(80, 20),
          characters: "Click me",
          style: { fontSize: 14 },
          textProp: "Label#8:0",
        } as FigmaNode,
      ],
    });
    const { html } = convertNode(n);
    expect(html).toContain("Click me");
    expect(html).not.toContain("{label}");
  });
});

const textLeaf = (name: string, chars: string, size = 14): FigmaNode =>
  ({
    id: "t-" + name,
    name,
    type: "TEXT",
    absoluteBoundingBox: box(80, 20),
    characters: chars,
    style: { fontSize: size },
  }) as FigmaNode;

const card = (id: string, title: string): FigmaNode =>
  frame({
    id,
    name: "Card",
    layoutMode: "VERTICAL",
    absoluteBoundingBox: box(120, 60),
    children: [textLeaf("Title", title)],
  });

describe("converter: semantic landmarks", () => {
  it("emits <nav>/<header>/<footer> from the layer name", () => {
    const nav = convertNode(frame({ name: "Navbar", children: [textLeaf("Home", "Home")] }), {
      absolutePositioning: true,
      semantic: true,
    });
    expect(nav.code).toContain("<nav");
    const footer = convertNode(frame({ name: "Footer", children: [textLeaf("c", "©")] }), {
      absolutePositioning: true,
      semantic: true,
    });
    expect(footer.code).toContain("<footer");
  });

  it("does not emit landmarks when semantic mode is off", () => {
    const { code } = convertNode(frame({ name: "Navbar", children: [textLeaf("Home", "Home")] }));
    expect(code).not.toContain("<nav");
  });
});

describe("converter: list semantics", () => {
  it("wraps a run of look-alike auto-layout children in <ul>/<li>", () => {
    const list = frame({
      name: "List",
      layoutMode: "VERTICAL",
      children: [card("a", "One"), card("b", "Two"), card("c", "Three")],
    });
    const { html } = convertNode(list, { absolutePositioning: true, semantic: true });
    expect(html).toContain("<ul");
    expect(html).toContain("<li");
  });
});

describe("converter: repeating children → .map()", () => {
  it("collapses identical-structure siblings into a single map (JSX only)", () => {
    const list = frame({
      name: "List",
      layoutMode: "VERTICAL",
      children: [card("a", "One"), card("b", "Two"), card("c", "Three")],
    });
    const { code, html } = convertNode(list);
    expect(code).toContain(".map((item, i) =>");
    expect(code).toContain("item.title");
    expect(code).toContain("key={i}");
    // HTML keeps the flat, expanded markup — no map expression.
    expect(html).not.toContain(".map(");
    expect(html).toContain("One");
    expect(html).toContain("Three");
  });
});

describe("converter: relative headings", () => {
  it("promotes the largest text in a block to a heading", () => {
    const n = frame({
      name: "Hero",
      layoutMode: "VERTICAL",
      children: [textLeaf("t1", "Big title", 20), textLeaf("t2", "small body", 14)],
    });
    const { code } = convertNode(n, { absolutePositioning: true, semantic: true });
    expect(code).toContain("<h2");
  });
});

describe("converter: icon-only control gets an aria-label", () => {
  it("labels a clickable icon button from its layer name", () => {
    const n = frame({
      name: "Play",
      clickable: true,
      layoutMode: "HORIZONTAL",
      children: [frame({ id: "bg", name: "bg", absoluteBoundingBox: box(20, 20) })],
    });
    const { code } = convertNode(n, { absolutePositioning: true, semantic: true });
    expect(code).toContain("<button");
    expect(code).toContain('aria-label="Play"');
  });
});

describe("converter: BOOLEAN / INSTANCE_SWAP component properties", () => {
  it("gates a subtree with a boolean prop (JSX only)", () => {
    const n = frame({
      name: "Badge",
      componentName: "Badge",
      componentProperties: { "Show Icon#2:1": { type: "BOOLEAN", value: true } },
      children: [
        { ...textLeaf("Label", "New"), visibleProp: "Show Icon#2:1" } as FigmaNode,
      ],
    });
    const { code, html } = convertNode(n);
    expect(code).toContain("showIcon?: boolean");
    expect(code).toContain("showIcon = true");
    expect(code).toContain("{showIcon && (");
    // HTML has no conditional — the content is always present.
    expect(html).toContain("New");
    expect(html).not.toContain("showIcon");
  });

  it("turns an INSTANCE_SWAP into a ReactNode slot", () => {
    const n = frame({
      name: "Button",
      componentName: "Button",
      componentProperties: { "Icon#3:0": { type: "INSTANCE_SWAP", value: "123:45" } },
      children: [
        { ...frame({ id: "ico", name: "Icon" }), swapProp: "Icon#3:0" } as FigmaNode,
      ],
    });
    const { code } = convertNode(n);
    expect(code).toContain("ReactNode");
    expect(code).toContain("icon?: ReactNode");
    expect(code).toContain("{icon}");
  });
});

describe("converter: hyperlink runs", () => {
  it("wraps a linked text run in an inline <a href>", () => {
    const n: FigmaNode = {
      id: "t",
      name: "Text",
      type: "TEXT",
      absoluteBoundingBox: box(200, 20),
      characters: "See our terms here",
      style: { fontSize: 16, fontWeight: 400 },
      styledSegments: [
        { characters: "See our ", fontWeight: 400 },
        { characters: "terms", fontWeight: 400, href: "https://example.com/terms" },
        { characters: " here", fontWeight: 400 },
      ],
    } as FigmaNode;
    const { html } = convertNode(n);
    expect(html).toContain('<a');
    expect(html).toContain('href="https://example.com/terms"');
    expect(html).toContain("terms");
  });
});

describe("converter: blend mode & vertical text align", () => {
  it("emits a mix-blend utility", () => {
    const { code } = convertNode(frame({ blendMode: "MULTIPLY" }));
    expect(code).toContain("mix-blend-multiply");
  });

  it("centers text vertically with a flex column", () => {
    const n = textLeaf("t", "Hello", 16);
    n.style = { ...n.style, textAlignVertical: "CENTER" };
    const { code } = convertNode(n);
    expect(code).toContain("justify-center");
  });
});

describe("converter: FigmaToCode-inspired features", () => {
  it("keeps an off-centre CENTER-constrained child from collapsing to the middle", () => {
    const parent = frame({
      absoluteBoundingBox: box(1000, 200),
      children: [
        frame({
          id: "2:1",
          name: "Heading",
          absoluteBoundingBox: box(300, 40, 0, 0), // centre at x=150, parent centre 500
          constraints: { horizontal: "CENTER", vertical: "MIN" },
        }),
      ],
    });
    const { code } = convertNode(parent);
    // offset = 150 - 500 = -350
    expect(code).toContain("left-[calc(50%_-_350px)]");
    expect(code).toContain("-translate-x-1/2");
    expect(code).not.toContain("left-1/2 -translate-x-1/2");
  });

  it("stays exactly centered when the child is truly centered", () => {
    const parent = frame({
      absoluteBoundingBox: box(1000, 200),
      children: [
        frame({
          id: "2:2",
          name: "Middle",
          absoluteBoundingBox: box(200, 40, 400, 0), // centre 500 == parent centre
          constraints: { horizontal: "CENTER", vertical: "MIN" },
        }),
      ],
    });
    const { code } = convertNode(parent);
    expect(code).toContain("left-1/2");
    expect(code).not.toContain("calc(");
  });

  it("recovers the un-rotated size/position of a rotated node", () => {
    // A 100x40 box rotated 90° has an 40x100 AABB; we should emit the real
    // 100x40 size and rotate around the centre, not the swollen AABB.
    const parent = frame({
      absoluteBoundingBox: box(400, 400),
      children: [
        frame({
          id: "3:1",
          name: "Rotated",
          rotation: 90,
          absoluteBoundingBox: box(40, 100, 100, 100),
        }),
      ],
    });
    const { code } = convertNode(parent);
    expect(code).toContain("w-[100px]");
    expect(code).toContain("h-[40px]");
    expect(code).toContain("rotate-[90deg]");
  });

  it("treats an SVG-export-marked container as a single icon asset", () => {
    const n = frame({
      name: "Logo",
      svgExport: true,
      children: [
        { id: "4:1", name: "v", type: "VECTOR", absoluteBoundingBox: box(20, 20) } as FigmaNode,
      ],
    });
    const { html } = convertNode(n);
    expect(html).toContain("@@ASSET:");
  });

  it("turns inferred auto-layout into flex (opt-in) and sorts children by axis", () => {
    const parent = frame({
      name: "Row",
      inferredLayout: { layoutMode: "HORIZONTAL", itemSpacing: 12, paddingLeft: 8 },
      children: [
        frame({ id: "5:2", name: "B", absoluteBoundingBox: box(40, 40, 200, 0) }),
        frame({ id: "5:1", name: "A", absoluteBoundingBox: box(40, 40, 0, 0) }),
      ],
    });
    const { code } = convertNode(parent, { absolutePositioning: true, inferLayout: true });
    expect(code).toContain("flex");
    expect(code).toContain("gap-[12px]");
    // Sorted: A (x=0) before B (x=200)
    expect(code.indexOf('"A"') === -1 ? code.indexOf(">A<") : code.indexOf('"A"')).toBeLessThan(
      code.indexOf(">B<") === -1 ? code.length : code.indexOf(">B<"),
    );
  });

  it("flattens a single curved-text node (text on a path) into an SVG asset", () => {
    // A ring of text: one TEXT node whose 180×180 box is far taller than its
    // ~3 wrapped lines would be — the geometry heuristic must fire.
    const n = {
      id: "18:1",
      name: "Оставьте заявку",
      type: "TEXT",
      characters:
        "Оставьте заявку / Оставьте заявку / Оставьте заявку / Оставьте заявку /",
      absoluteBoundingBox: box(180, 180),
      style: { fontSize: 12, lineHeightPx: 14 },
    } as FigmaNode;
    const { html, assets } = convertNode(n);
    expect(assets).toHaveLength(1);
    expect(assets[0].kind).toBe("svg");
    expect(html).toContain("@@ASSET:");
    expect(html).toContain("w-[180px]");
    expect(html).not.toContain("Оставьте заявку /");
  });

  it("honours the plugin's svgExport mark on a text node", () => {
    const n = {
      id: "19:1",
      name: "Arc",
      type: "TEXT",
      svgExport: true,
      characters: "along a path",
      absoluteBoundingBox: box(120, 40),
      style: { fontSize: 14 },
    } as FigmaNode;
    const { assets } = convertNode(n);
    expect(assets).toHaveLength(1);
    expect(assets[0].kind).toBe("svg");
  });

  it("keeps a tall wrapped paragraph as text, not an SVG", () => {
    // 300×280 body copy: many wrapped lines fully explain the height.
    const long = "слово ".repeat(80).trim();
    const n = {
      id: "20:1",
      name: "Body",
      type: "TEXT",
      characters: long,
      textAutoResize: "HEIGHT",
      absoluteBoundingBox: box(300, 280),
      style: { fontSize: 16, lineHeightPx: 20 },
    } as FigmaNode;
    const { html, assets } = convertNode(n);
    expect(assets).toHaveLength(0);
    expect(html).toContain("слово");
  });

  it("flattens circular text (rotated letters) into one SVG asset", () => {
    const letters = ["О", "с", "т", "а", "в", "ь"].map((ch, i) => ({
      id: `14:${i}`,
      name: ch,
      type: "TEXT",
      characters: ch,
      rotation: -60 + i * 24,
      absoluteBoundingBox: box(12, 14, 80 + i * 10, 10),
      style: { fontSize: 12 },
    })) as FigmaNode[];
    const ring = frame({
      name: "Ring",
      absoluteBoundingBox: box(180, 180),
      children: letters,
    });
    const { html, assets } = convertNode(ring);
    expect(assets).toHaveLength(1);
    expect(assets[0].kind).toBe("svg");
    expect(html).toContain("@@ASSET:");
    // The letters must not leak out as individual <p> elements.
    expect(html).not.toContain(">О<");
  });

  it("ignores an svgExport mark on a section that holds real text", () => {
    // Designers routinely leave export settings on a whole section; obeying
    // that would flatten every heading and paragraph into one picture.
    const n = frame({
      name: "Структура авторынка",
      svgExport: true,
      absoluteBoundingBox: box(1340, 530),
      children: [
        {
          id: "21:1",
          name: "t",
          type: "TEXT",
          characters: "53%",
          absoluteBoundingBox: box(120, 60, 40, 40),
          style: { fontSize: 48 },
        } as FigmaNode,
        { id: "21:2", name: "v", type: "VECTOR", absoluteBoundingBox: box(20, 20, 900, 40) } as FigmaNode,
      ],
    });
    const { html } = convertNode(n);
    expect(html).toContain("53%");
  });

  it("does not flatten a wide section that merely contains ring labels", () => {
    // Rotated donut-chart captions next to upright stat text: the section is
    // 1340×530, nothing like the square box of an actual text ring.
    const captions = ["ЛОКАЛЬНОЕ", "ИМПОРТ", "ДОЛЯ"].map((ch, i) => ({
      id: `22:${i}`,
      name: ch,
      type: "TEXT",
      characters: ch,
      rotation: -40 + i * 30,
      absoluteBoundingBox: box(120, 16, 900 + i * 40, 60 + i * 160),
      style: { fontSize: 12 },
    })) as FigmaNode[];
    const n = frame({
      name: "Структура",
      absoluteBoundingBox: box(1340, 530),
      children: captions,
    });
    const { html, assets } = convertNode(n);
    expect(assets).toHaveLength(0);
    expect(html).toContain("ИМПОРТ");
  });

  it("flattens a word split into per-glyph text nodes (text on a path)", () => {
    // Figma's path text: one TEXT node per letter, each tilted a degree or two
    // along a gentle arc. As HTML it explodes into absolutely-placed <p>s.
    const glyphs = "ЛОКАЛЬНОЕ".split("").map((ch, i) => ({
      id: `25:${i}`,
      name: ch,
      type: "TEXT",
      characters: ch,
      rotation: 1.6 + i * 0.05,
      absoluteBoundingBox: box(12, 22, i * 12, i * i * 0.2),
      style: { fontSize: 18 },
    })) as FigmaNode[];
    const n = frame({
      name: "Linked Path Group",
      type: "GROUP",
      absoluteBoundingBox: box(241, 117),
      children: glyphs,
    });
    const { html, assets } = convertNode(n);
    expect(assets).toHaveLength(1);
    expect(assets[0].kind).toBe("svg");
    expect(html).not.toContain(">Л<");
  });

  it("exports a raster-masked group as PNG, not SVG", () => {
    // A photo clipped by a mask has no vectors to keep — an SVG export would
    // just wrap the bitmap in base64.
    const n = frame({
      name: "Mask group",
      type: "GROUP",
      absoluteBoundingBox: box(464, 273),
      children: [
        {
          id: "26:1",
          name: "map",
          type: "RECTANGLE",
          isMask: true,
          absoluteBoundingBox: box(464, 273),
          fills: [{ type: "IMAGE", scaleMode: "STRETCH", imageRef: "x" }],
        } as unknown as FigmaNode,
        {
          id: "26:2",
          name: "fill",
          type: "RECTANGLE",
          absoluteBoundingBox: box(461, 285),
          fills: [{ type: "SOLID", color: { r: 1, g: 0.44, b: 0.02, a: 1 } }],
        } as FigmaNode,
      ],
    });
    const { assets } = convertNode(n);
    expect(assets).toHaveLength(1);
    expect(assets[0].kind).toBe("png");
  });

  it("recovers a square node's size at exactly 45° (the singular case)", () => {
    // A 289px donut ring turned 45°: its AABB is 289·√2 ≈ 409. Inverting the
    // general equations is singular here, but a square has one unknown.
    const n = frame({
      name: "Ellipse",
      type: "ELLIPSE",
      rotation: 45,
      absoluteBoundingBox: box(409, 409, 0, 0),
      arcData: { startingAngle: 0, endingAngle: 4.54, innerRadius: 0.7 },
    });
    const { assets } = convertNode(n);
    expect(assets).toHaveLength(1);
    expect(assets[0].className).toMatch(/w-\[289px\]/);
    expect(assets[0].className).toMatch(/h-\[289px\]/);
  });

  it("prefers the plugin's exact size over inverting the bounding box", () => {
    const n = frame({
      name: "Card",
      rotation: 45,
      size: { x: 200, y: 100 },
      absoluteBoundingBox: box(212, 212),
    });
    const { html } = convertNode(n);
    expect(html).toContain("w-[200px]");
    expect(html).toContain("h-[100px]");
  });

  it("keeps a full-width row of cards on one line despite the container stroke", () => {
    // Three cards of 447+446+447 = exactly the container's 1340px. A CSS border
    // would shrink the content box to 1338 and bounce the last card onto the
    // next line; a Figma stroke never takes layout space.
    const card = (id: string, w: number) =>
      frame({
        id,
        name: "Card",
        absoluteBoundingBox: box(w, 120),
        layoutSizingHorizontal: "FIXED",
      });
    const n = frame({
      name: "Content",
      absoluteBoundingBox: box(1340, 240),
      layoutMode: "HORIZONTAL",
      layoutWrap: "WRAP",
      strokes: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 0.3 } }],
      strokeWeight: 1,
      strokeAlign: "INSIDE",
      children: [card("28:1", 447), card("28:2", 446), card("28:3", 447)],
    });
    const { html } = convertNode(n);
    expect(html).toContain("outline:");
    expect(html).toContain("outline-offset: -1px");
    expect(html).not.toContain("border-[1px]");
  });

  it("gives FILL children a zero basis so they split the row evenly", () => {
    const kid = (id: string, chars: string) =>
      frame({
        id,
        name: "Cell",
        absoluteBoundingBox: box(400, 80),
        layoutSizingHorizontal: "FILL",
        children: [
          {
            id: id + "t",
            name: "t",
            type: "TEXT",
            characters: chars,
            absoluteBoundingBox: box(380, 40),
            style: { fontSize: 16 },
          } as FigmaNode,
        ],
      });
    const n = frame({
      name: "Row",
      absoluteBoundingBox: box(1200, 80),
      layoutMode: "HORIZONTAL",
      layoutWrap: "WRAP",
      children: [kid("29:1", "короткий"), kid("29:2", "заметно более длинный текст в ячейке")],
    });
    const { html } = convertNode(n);
    // Both cells must carry grow + basis-0, or the longer one takes more room.
    expect(html.match(/grow basis-0|basis-0 grow/g)?.length).toBe(2);
  });

  it("keeps a 90°-rotated line vertical when it is exported", () => {
    // Figma draws every LINE horizontally and rotates it, so a grid line is a
    // 369px line turned 90°. The export is rendered as it appears — vertical —
    // so the <img> must take the rotated bounding box, not the un-rotated one.
    // Sized 369px wide it would blow open the column it sits in.
    const n = frame({
      name: "Line 3",
      type: "LINE",
      rotation: 90,
      size: { x: 369, y: 0 },
      // Rotating leaves floating-point dust in the box — not a clean zero.
      absoluteBoundingBox: { x: 100, y: 0, width: 2.2e-13, height: 369 },
      strokeWeight: 1,
      strokes: [{ type: "SOLID", color: { r: 0.85, g: 0.85, b: 0.85, a: 1 } }],
    });
    const { html, assets } = convertNode(n);
    expect(assets).toHaveLength(1);
    expect(html).toContain("w-[1px]");
    expect(html).toContain("h-[369px]");
    expect(html).not.toContain("w-[369px]");
    // The export already carries the rotation — rotating again would undo it.
    expect(html).not.toContain("rotate-");
  });

  it("keeps opacity, blur and blend mode on an exported image", () => {
    // The map layer is a photo at 73% in DIFFERENCE mode with an 18px blur.
    // Emitting those after the asset short-circuit dropped them silently.
    const n = frame({
      name: "2 27",
      type: "RECTANGLE",
      absoluteBoundingBox: box(1012, 488),
      fills: [{ type: "IMAGE", scaleMode: "CROP" }],
      opacity: 0.73,
      blendMode: "DIFFERENCE",
      effects: [{ type: "LAYER_BLUR", visible: true, radius: 17.9 }],
    } as unknown as Partial<FigmaNode>);
    const { html, assets } = convertNode(n);
    expect(assets).toHaveLength(1);
    expect(html).toContain("opacity-[0.73]");
    expect(html).toContain("blur-[18px]");
    expect(html).toContain("mix-blend-difference");
  });

  it("keeps a drop shadow on an exported icon", () => {
    const n = frame({
      name: "Pin",
      type: "VECTOR",
      absoluteBoundingBox: box(28, 28),
      effects: [
        {
          type: "DROP_SHADOW",
          visible: true,
          radius: 4,
          offset: { x: 0, y: 2 },
          color: { r: 0, g: 0, b: 0, a: 0.25 },
        },
      ],
    } as unknown as Partial<FigmaNode>);
    expect(convertNode(n).html).toContain("shadow-[0px_2px_4px_0px");
  });

  it("keeps line breaks inside styled text runs", () => {
    // Mixed styling emits <span> runs; a raw newline in one of them collapses
    // to a space, joining a two-line caption into one.
    const n = frame({
      name: "caption",
      type: "TEXT",
      characters: "Автомобильные дороги:\nулучшено.",
      absoluteBoundingBox: box(178, 24),
      style: { fontSize: 8, lineHeightPx: 12 },
      styledSegments: [
        { characters: "Автомобильные дороги:\n", fontWeight: 600 },
        { characters: "улучшено.", fontWeight: 400 },
      ],
    } as unknown as Partial<FigmaNode>);
    const { code, html } = convertNode(n);
    expect(code).toContain("Автомобильные дороги:<br />");
    expect(html).toContain("Автомобильные дороги:<br />");
    expect(code).not.toMatch(/дороги:\s*\n/);
  });

  it("flattens a frame whose children undo its rotation", () => {
    // A caption block built sideways: frame at +90°, every child at -90°, so
    // nothing is turned on screen. Reproduced literally, the flex row sizes the
    // children along the wrong axis and throws them outside the frame.
    const kid = (id: string, x: number, y: number, w: number, h: number) =>
      ({
        id,
        name: "line",
        type: "TEXT",
        characters: "текст",
        rotation: -90,
        absoluteBoundingBox: box(w, h, x, y),
        style: { fontSize: 11 },
      }) as FigmaNode;
    const n = frame({
      name: "Frame 427319025",
      rotation: 90,
      absoluteBoundingBox: box(144, 87, 1000, 40),
      layoutMode: "HORIZONTAL",
      itemSpacing: 11,
      layoutSizingHorizontal: "HUG",
      layoutSizingVertical: "HUG",
      children: [kid("30:1", 1000, 40, 144, 16), kid("30:2", 1000, 60, 144, 63)],
    });
    const { html } = convertNode(n, { absolutePositioning: true });
    // No rotation survives, and the children sit at their real offsets.
    expect(html).not.toContain("rotate-");
    expect(html).toContain("w-[144px]");
    expect(html).toContain("top-[20px]");
    // The frame keeps a size: its children are pinned now, so hugging them
    // would collapse it to nothing and the text would spill out.
    expect(html).toMatch(/w-\[144px\][^"]*h-\[87px\]/);
  });

  it("draws a donut segment as inline SVG instead of exporting it", () => {
    // 260° of a ring, turned -45°. Exporting this as an image never lines up:
    // the bounding box is the rotated square's AABB, the export is bounded by
    // the drawn arc. Drawn from the geometry it is exact.
    const n = frame({
      name: "Ellipse 4002",
      type: "ELLIPSE",
      rotation: -45,
      absoluteBoundingBox: box(410, 410, 0, 0),
      arcData: { startingAngle: 0, endingAngle: 4.5427, innerRadius: 0.7 },
      fills: [{ type: "SOLID", color: { r: 1, g: 0.44, b: 0.02, a: 1 } }],
    });
    const { html, assets } = convertNode(n);
    expect(assets).toHaveLength(0);
    expect(html).toContain("<svg");
    expect(html).toContain('viewBox="0 0 290 290"');
    // Figma's angles are already clockwise on screen, so the node's -45°
    // rotation puts the start at -45° — (145 + 145·cos45, 145 - 145·sin45).
    expect(html).toContain("M 248 42");
    // ...and the arc runs clockwise from there (sweep flag 1).
    expect(html).toContain("A 145 145 0 1 1");
    expect(html).toContain('fill="#ff7005"');
  });

  it("does not infer a flow when a child is rotated", () => {
    // A chart's axis captions: the y-axis one is turned -90°, so Figma sees a
    // tall narrow box on the left and infers a column. CSS lays the element out
    // by its unrotated box, which would swap the two captions.
    const n = frame({
      name: "график",
      absoluteBoundingBox: box(1340, 527, 0, 0),
      inferredLayout: {
        layoutMode: "VERTICAL",
        itemSpacing: 167,
        paddingLeft: 0,
        paddingRight: 601,
        paddingTop: 161,
        paddingBottom: 0,
      },
      children: [
        frame({
          name: "Марки автомобилей",
          type: "TEXT",
          characters: "Марки автомобилей",
          rotation: -90,
          absoluteBoundingBox: box(23, 160, 0, 161),
        }),
        frame({
          name: "Продажи шт.",
          type: "TEXT",
          characters: "Продажи шт.",
          absoluteBoundingBox: box(110, 23, 620, 500),
        }),
      ],
    });
    const { html } = convertNode(n, { inferLayout: true, absolutePositioning: true });
    expect(html).not.toContain("gap-[167px]");
    // Pinned where the designer put them: the turned caption on the left edge.
    expect(html).toContain("top-[500px]");
  });

  it("drops end alignment when the row is wider than its frame", () => {
    // Figma clips such a frame on the right; justify-end pushes the overflow
    // off the left instead, where overflow-hidden eats the first column.
    const n = frame({
      name: "Автомобильный рынок",
      layoutMode: "HORIZONTAL",
      itemSpacing: 53,
      primaryAxisAlignItems: "MAX",
      clipsContent: true,
      absoluteBoundingBox: box(1340, 532),
      children: [
        frame({ name: "Table", absoluteBoundingBox: box(756, 532) }),
        frame({ name: "Photo", absoluteBoundingBox: box(905, 645) }),
      ],
    });
    const { html } = convertNode(n);
    expect(html).not.toContain("justify-end");
  });

  it("keeps end alignment when the children do fit", () => {
    const n = frame({
      name: "Row",
      layoutMode: "HORIZONTAL",
      itemSpacing: 20,
      primaryAxisAlignItems: "MAX",
      absoluteBoundingBox: box(1340, 100),
      children: [
        frame({ name: "A", absoluteBoundingBox: box(200, 100) }),
        frame({ name: "B", absoluteBoundingBox: box(200, 100) }),
      ],
    });
    const { html } = convertNode(n);
    expect(html).toContain("justify-end");
  });

  it("does not turn a free-form rotated group twice", () => {
    // Figma keeps the group's rotation relative to its parent but its children's
    // boxes in absolute coordinates, so the turn is already in those numbers.
    // Wrapping them in a rotate() moved the circles off their rings.
    const n = frame({
      name: "Content",
      absoluteBoundingBox: box(600, 600, 0, 0),
      children: [
        frame({
          name: "Group 1321314689",
          rotation: 90,
          absoluteBoundingBox: box(390, 383, 100, 100),
          children: [
            frame({
              name: "Ellipse 4026",
              type: "ELLIPSE",
              rotation: 90,
              absoluteBoundingBox: box(87, 87, 118, 118),
            }),
          ],
        }),
      ],
    });
    const { html } = convertNode(n, { absolutePositioning: true });
    expect(html).not.toContain("rotate-[90deg]");
    // The group keeps the box it really occupies, and the circle sits at its
    // true offset inside it (18px in from the corner).
    expect(html).toContain("w-[390px]");
    expect(html).toContain("h-[383px]");
    expect(html).toContain("left-[18px]");
    expect(html).toContain("top-[18px]");
  });

  it("starts a donut sector where Figma does, running clockwise", () => {
    // A stacked donut: each sector starts at 12 o'clock (startingAngle -90°)
    // and sweeps clockwise, later slices painted over earlier ones. Negating
    // the angle put every sector at 6 o'clock and reversed the slice order,
    // so the 2% sliver ended up on the wrong side of the chart.
    const n = frame({
      name: "Ellipse 3961",
      type: "ELLIPSE",
      absoluteBoundingBox: box(567, 567),
      // 43% of the circle: -90° → 65.8°.
      arcData: {
        startingAngle: -Math.PI / 2,
        endingAngle: -Math.PI / 2 + Math.PI * 2 * 0.43,
        innerRadius: 0,
      },
      fills: [{ type: "SOLID", color: { r: 0.07, g: 0.07, b: 0.07, a: 1 } }],
    });
    const { html } = convertNode(n);
    // Top of the circle, then clockwise (sweep flag 1) through the right side.
    expect(html).toContain("L 284 0");
    expect(html).toMatch(/A 284 284 0 0 1 \d/);
  });

  it("gives a progress ring round ends, not blunt ones", () => {
    // Figma's cornerRadius on a ring segment rounds its two ends. At half the
    // ring's thickness the ends are fully round — a stroked centreline with
    // round caps, not a filled sector.
    const n = frame({
      name: "Ellipse 4020",
      type: "ELLIPSE",
      absoluteBoundingBox: box(291, 291),
      // 25% of the ring, 30px thick (outer 145.5, inner 115.5).
      arcData: { startingAngle: 0, endingAngle: Math.PI / 2, innerRadius: 0.79 },
      cornerRadius: 24,
      fills: [{ type: "SOLID", color: { r: 1, g: 0.44, b: 0.02, a: 1 } }],
    });
    const { html, code } = convertNode(n);
    expect(html).toContain('stroke-linecap="round"');
    expect(code).toContain('strokeLinecap="round"');
    expect(html).toContain('fill="none"');
    // A single centreline arc — no "L" back along an inner edge.
    expect(html).not.toMatch(/<path d="[^"]*L[^"]*"/);
    // The box radius must not leak out as a CSS border-radius on the <svg>.
    expect(html).not.toContain("rounded-[24px]");
  });

  it("keeps blunt ends when the ring has no corner radius", () => {
    const n = frame({
      name: "Ellipse",
      type: "ELLIPSE",
      absoluteBoundingBox: box(291, 291),
      arcData: { startingAngle: 0, endingAngle: Math.PI / 2, innerRadius: 0.79 },
      fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    const { html } = convertNode(n);
    expect(html).not.toContain("stroke-linecap");
    expect(html).toMatch(/<path d="[^"]*L[^"]*"/);
  });

  it("draws a full ring (360° with a hole) without fill-rule", () => {
    const n = frame({
      name: "Ring",
      type: "ELLIPSE",
      absoluteBoundingBox: box(100, 100),
      arcData: { startingAngle: 0, endingAngle: Math.PI * 2, innerRadius: 0.5 },
      fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    const { html } = convertNode(n);
    expect(html).not.toContain("fill-rule");
    // Outer circle clockwise, inner counter-clockwise → the hole.
    expect(html).toContain("A 50 50 0 1 0");
    expect(html).toContain("A 25 25 0 1 1");
  });

  it("keeps a section that contains ringed labels out of the ring test", () => {
    // 28 rotated glyphs among 39 texts, aspect ~1.9 — every ratio a ring has,
    // but its children are frames, so it is a layout, not a ring.
    const glyphs = Array.from({ length: 6 }, (_, i) => ({
      id: `27:${i}`,
      name: "г",
      type: "TEXT",
      characters: "г",
      rotation: 30 + i * 10,
      absoluteBoundingBox: box(12, 14, 600 + i * 12, 300),
      style: { fontSize: 12 },
    })) as FigmaNode[];
    const section = frame({
      name: "Секция",
      absoluteBoundingBox: box(1340, 700),
      children: [
        frame({ id: "27:100", name: "Ring", absoluteBoundingBox: box(200, 200, 600, 250), children: glyphs }),
        {
          id: "27:200",
          name: "h",
          type: "TEXT",
          characters: "Структура авторынка",
          absoluteBoundingBox: box(400, 24),
          style: { fontSize: 24 },
        } as FigmaNode,
      ],
    });
    const { html } = convertNode(section);
    expect(html).toContain("Структура авторынка");
  });

  it("flattens a vector-masked group into one SVG asset", () => {
    // A country map: an outline masks a filled rectangle. Rendered layer by
    // layer that is just a solid black block the size of the group.
    const n = frame({
      name: "Китай",
      type: "GROUP",
      absoluteBoundingBox: box(240, 200),
      children: [
        {
          id: "23:1",
          name: "outline",
          type: "VECTOR",
          isMask: true,
          absoluteBoundingBox: box(240, 200),
        } as FigmaNode,
        {
          id: "23:2",
          name: "fill",
          type: "RECTANGLE",
          absoluteBoundingBox: box(240, 200),
          fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } }],
        } as FigmaNode,
      ],
    });
    const { html, assets } = convertNode(n);
    expect(assets).toHaveLength(1);
    expect(assets[0].kind).toBe("svg");
    expect(html).toContain("@@ASSET:");
  });

  it("warns instead of flattening when a masked group holds real text", () => {
    const n = frame({
      name: "Карта",
      absoluteBoundingBox: box(240, 200),
      children: [
        {
          id: "24:1",
          name: "outline",
          type: "VECTOR",
          isMask: true,
          absoluteBoundingBox: box(240, 200),
        } as FigmaNode,
        {
          id: "24:2",
          name: "pct",
          type: "TEXT",
          characters: "40%",
          absoluteBoundingBox: box(60, 24, 90, 90),
          style: { fontSize: 24 },
        } as FigmaNode,
      ],
    });
    const { html, warnings } = convertNode(n);
    expect(html).toContain("40%");
    expect(warnings?.join(" ")).toContain("маска");
  });

  it("keeps ordinary multi-text containers as HTML (not an SVG)", () => {
    const texts = [0, 1, 2].map((i) => ({
      id: `15:${i}`,
      name: `t${i}`,
      type: "TEXT",
      characters: `строка ${i}`,
      absoluteBoundingBox: box(100, 16, 0, i * 20),
      style: { fontSize: 14 },
    })) as FigmaNode[];
    const n = frame({ name: "List", absoluteBoundingBox: box(100, 60), children: texts });
    const { assets, html } = convertNode(n);
    expect(assets).toHaveLength(0);
    expect(html).toContain("строка 0");
  });

  it("gives soft-wrapped text its box width instead of whitespace-nowrap", () => {
    // 2 explicit lines ("...волос\nHairline") rendered as 3 (44px lines in a
    // 132px box) → the box wraps; the width must be emitted.
    const n = {
      id: "16:1",
      name: "H1",
      type: "TEXT",
      characters: "Инновационный центр здоровья волос\nHairline",
      textAutoResize: "WIDTH_AND_HEIGHT",
      absoluteBoundingBox: box(450, 132),
      style: { fontSize: 40, lineHeightPx: 44 },
    } as FigmaNode;
    const { html } = convertNode(n);
    expect(html).toContain("w-[450px]");
    expect(html).not.toContain("whitespace-nowrap");
  });

  it("keeps whitespace-nowrap for genuinely hugging single-line text", () => {
    const n = {
      id: "17:1",
      name: "label",
      type: "TEXT",
      characters: "результаты",
      textAutoResize: "WIDTH_AND_HEIGHT",
      absoluteBoundingBox: box(100, 18),
      style: { fontSize: 15, lineHeightPx: 18 },
    } as FigmaNode;
    const { html } = convertNode(n);
    expect(html).toContain("whitespace-nowrap");
    expect(html).not.toContain("w-[100px]");
  });

  it("keeps the corner radius on an exported image/video asset", () => {
    const n = frame({
      name: "Photo",
      absoluteBoundingBox: box(670, 700),
      cornerRadius: 40,
      fills: [{ type: "IMAGE", scaleMode: "FILL" }],
    });
    const { html, assets } = convertNode(n);
    // The <img> itself must carry the rounding…
    expect(html).toContain("rounded-[40px]");
    // …and so must the recorded className (HTML/Vue inject it onto inline SVG).
    expect(assets[0].className).toContain("rounded-[40px]");
  });

  it("keeps per-corner radii on an exported image asset", () => {
    const n = frame({
      name: "Photo",
      absoluteBoundingBox: box(200, 200),
      rectangleCornerRadii: [8, 0, 0, 8],
      fills: [{ type: "IMAGE" }],
    });
    const { html } = convertNode(n);
    expect(html).toContain("rounded-tl-[8px]");
    expect(html).toContain("rounded-bl-[8px]");
  });

  it("exports a video fill as a still image asset (first frame)", () => {
    const n = frame({
      name: "Clip",
      absoluteBoundingBox: box(320, 180),
      fills: [{ type: "VIDEO", scaleMode: "FILL" }],
    });
    const { html, assets, warnings } = convertNode(n);
    // Same path as a photo: a PNG asset rendered as an <img>, not an empty box.
    expect(assets).toHaveLength(1);
    expect(assets[0].kind).toBe("png");
    expect(html).toContain("@@ASSET:");
    expect(html).toContain("object-cover");
    // …and it's flagged as lossy, since the motion is gone.
    expect(warnings?.join(" ")).toContain("первым кадром");
  });

  it("uses a video fill on a container as a background image", () => {
    const n = frame({
      name: "Hero",
      absoluteBoundingBox: box(800, 400),
      fills: [{ type: "VIDEO", scaleMode: "FILL" }],
      children: [
        {
          id: "13:1",
          name: "t",
          type: "TEXT",
          absoluteBoundingBox: box(100, 20, 10, 10),
          characters: "Заголовок",
          style: { fontSize: 20 },
        } as FigmaNode,
      ],
    });
    const { html } = convertNode(n);
    expect(html).toContain("background-image");
    expect(html).toContain("bg-cover");
  });

  it("recovers a uniform grid as flex-wrap (opt-in), not absolute soup", () => {
    // 6 cards, 440×354, in a 3×2 grid with 20px gaps.
    const cards = [
      [0, 0], [460, 0], [920, 0],
      [0, 374], [460, 374], [920, 374],
    ].map(([x, y], i) =>
      frame({ id: `9:${i}`, name: "Card", absoluteBoundingBox: box(440, 354, x, y) }),
    );
    const parent = frame({
      name: "Cards",
      absoluteBoundingBox: box(1360, 728),
      children: cards,
    });
    const { code } = convertNode(parent, { absolutePositioning: true, inferLayout: true });
    expect(code).toContain("flex");
    expect(code).toContain("flex-wrap");
    expect(code).toContain("gap-[20px]");
    // Cards flow — no absolute left/top pinning on them.
    expect(code).not.toContain("left-[460px]");
  });

  it("folds a full-bleed background leaf into the container and flows the rest", () => {
    // A 1440×894 frame: full-bleed white bg rect + header (y=40) + grid (y=126).
    const parent = frame({
      name: "Results",
      absoluteBoundingBox: box(1440, 894),
      children: [
        frame({
          id: "11:0",
          name: "Bg",
          absoluteBoundingBox: box(1440, 894, 0, 0),
          cornerRadius: 50,
          fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }],
        }),
        frame({ id: "11:1", name: "Header", absoluteBoundingBox: box(1360, 46, 40, 40) }),
        frame({ id: "11:2", name: "Grid", absoluteBoundingBox: box(1360, 728, 40, 126) }),
      ],
    });
    const { code } = convertNode(parent, { absolutePositioning: true, inferLayout: true });
    // Container flows as a column with padding from the frame edges…
    expect(code).toContain("flex-col");
    expect(code).toContain("p-[40px]"); // pl=pr=pt=pb=40 → single shorthand
    // …and the background rect is folded into the container itself, not a layer.
    expect(code).toContain("bg-[#ffffff]");
    expect(code).toContain("rounded-[50px]");
    expect(code).not.toContain("-z-10");
    expect(code).not.toContain("isolate");
    // Header/grid are no longer pinned by top offset.
    expect(code).not.toContain("top-[126px]");
  });

  it("keeps a background as a -z-10 overlay when the parent has its own fill", () => {
    // Parent already has a fill, so the bg leaf can't be folded in — it stays an
    // absolute overlay pushed behind the flow (isolate + -z-10).
    const parent = frame({
      name: "Panel",
      absoluteBoundingBox: box(1440, 894),
      fills: [{ type: "SOLID", color: { r: 0.9, g: 0.9, b: 0.9, a: 1 } }],
      children: [
        frame({
          id: "12:0",
          name: "Bg",
          absoluteBoundingBox: box(1440, 894, 0, 0),
          fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }],
        }),
        frame({ id: "12:1", name: "Header", absoluteBoundingBox: box(1360, 46, 40, 40) }),
        frame({ id: "12:2", name: "Grid", absoluteBoundingBox: box(1360, 728, 40, 126) }),
      ],
    });
    const { code } = convertNode(parent, { absolutePositioning: true, inferLayout: true });
    expect(code).toContain("flex-col");
    expect(code).toContain("isolate");
    expect(code).toContain("-z-10");
  });

  it("keeps overlapping free-form children absolute (not a grid)", () => {
    const parent = frame({
      name: "Art",
      absoluteBoundingBox: box(400, 400),
      children: [
        frame({ id: "10:1", name: "A", absoluteBoundingBox: box(300, 300, 0, 0) }),
        frame({ id: "10:2", name: "B", absoluteBoundingBox: box(300, 300, 50, 50) }),
        frame({ id: "10:3", name: "C", absoluteBoundingBox: box(300, 300, 80, 80) }),
      ],
    });
    const { code } = convertNode(parent, { absolutePositioning: true, inferLayout: true });
    expect(code).toContain("absolute");
    expect(code).not.toContain("flex-wrap");
  });

  it("leaves layout absolute when the infer flag is off", () => {
    const parent = frame({
      name: "Row",
      inferredLayout: { layoutMode: "HORIZONTAL", itemSpacing: 12 },
      children: [frame({ id: "6:1", name: "A", absoluteBoundingBox: box(40, 40, 0, 0) })],
    });
    const { code } = convertNode(parent, { absolutePositioning: true });
    expect(code).toContain("absolute");
    expect(code).not.toContain("gap-[12px]");
  });

  it("maps an angular gradient to a conic gradient", () => {
    const n = frame({
      fills: [
        {
          type: "GRADIENT_ANGULAR",
          gradientStops: [
            { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
            { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
          ],
        },
      ],
    });
    const { code } = convertNode(n);
    expect(code).toContain("conic-gradient(");
  });

  it("has no warnings for a plain frame", () => {
    expect(convertNode(frame({})).warnings).toBeUndefined();
  });

  it("gives fixed-width text a width so it wraps like Figma", () => {
    const t = textLeaf("t", "Ключевые направления проектирования", 36);
    t.absoluteBoundingBox = box(650, 90);
    t.textAutoResize = "HEIGHT";
    expect(convertNode(t).code).toContain("w-[650px]");
  });

  it("makes the root fluid in responsive mode", () => {
    const n = frame({ absoluteBoundingBox: box(1360, 554) });
    const { code } = convertNode(n, { absolutePositioning: true, responsive: true });
    expect(code).toContain("w-full");
    expect(code).toContain("max-w-[1360px]");
    expect(code).toContain("mx-auto");
    expect(code).not.toMatch(/[" ]w-\[1360px\]/);
  });

  it("keeps the root's fixed width without responsive mode", () => {
    const n = frame({ absoluteBoundingBox: box(1360, 554) });
    expect(convertNode(n).code).toContain("w-[1360px]");
  });

  it("leaves content-hugging text width-less", () => {
    const t = textLeaf("t", "Hi", 16);
    t.absoluteBoundingBox = box(40, 20);
    t.textAutoResize = "WIDTH_AND_HEIGHT";
    expect(convertNode(t).code).not.toMatch(/w-\[\d/);
  });

  it("emits translucent colours as space-free rgba (spaces break Tailwind classes)", () => {
    const n = textLeaf("t", "Hi", 16);
    n.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 0.6 } }];
    const { code } = convertNode(n);
    expect(code).toContain("text-[rgba(255,255,255,0.6)]");
    expect(code).not.toMatch(/rgba\([^)]*\s/); // no whitespace inside rgba()
  });
});

describe("converter: layer & style names", () => {
  const text = (name: string, style: Record<string, unknown>): FigmaNode =>
    ({
      id: "2:1",
      name,
      type: "TEXT",
      characters: "Hello",
      absoluteBoundingBox: box(100, 24),
      style,
    }) as unknown as FigmaNode;

  it("keeps layer and style names as data attributes when asked", () => {
    const n = frame({
      name: "Card / Header",
      fillStyleName: "surface-raised",
      children: [text("Label", { fontSize: 16, textStyleName: "body-regular" })],
    });
    const { html } = convertNode(n, { layerNames: true });
    expect(html).toContain('data-name="Card / Header"');
    expect(html).toContain('data-style="surface-raised"');
    expect(html).toContain('data-name="Label"');
    expect(html).toContain('data-style="body-regular"');
  });

  it("omits the annotations by default", () => {
    const n = frame({ name: "Card", fillStyleName: "surface-raised" });
    expect(convertNode(n).html).not.toContain("data-name");
  });

  it("takes the heading level from the shared text style", () => {
    const n = text("Some marketing copy", { fontSize: 14, textStyleName: "heading-h3" });
    expect(convertNode(n, { semantic: true }).html).toContain("<h3");
  });

  it("still collapses a repeated list whose items are named differently", () => {
    const item = (i: number): FigmaNode =>
      frame({
        id: `3:${i}`,
        name: `Card ${i}`,
        layoutMode: "VERTICAL",
        children: [
          {
            ...(text("Title", { fontSize: 16 }) as FigmaNode),
            id: `4:${i}`,
            characters: `Card ${i}`,
          },
        ],
      });
    const n = frame({
      name: "List",
      layoutMode: "HORIZONTAL",
      children: [item(1), item(2), item(3)],
    });
    const { jsx } = convertNode(n, { layerNames: true });
    expect(jsx).toContain(".map(");
  });
});

describe("free-form → flex (fewer absolute boxes)", () => {
  const white = [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }] as FigmaNode["fills"];
  // A logo on a white circle, wrapped in two redundant full-size groups.
  const badge = (i: number, x: number, y: number, dx = 0, dy = 0): FigmaNode => ({
    id: `b${i}`,
    name: `Group ${i}`,
    type: "GROUP",
    absoluteBoundingBox: box(237, 237, x, y),
    children: [
      {
        id: `g${i}`,
        name: "Inner",
        type: "GROUP",
        absoluteBoundingBox: box(237, 237, x, y),
        children: [
          { id: `e${i}`, name: "Ellipse", type: "ELLIPSE", fills: white, absoluteBoundingBox: box(237, 237, x, y) },
          {
            id: `v${i}`,
            name: "logo",
            type: "GROUP",
            absoluteBoundingBox: box(160, 60, x + 38.5 + dx, y + 88.5 + dy),
            children: [
              { id: `p${i}`, name: "path", type: "VECTOR", absoluteBoundingBox: box(160, 60, x + 38.5 + dx, y + 88.5 + dy) },
            ],
          },
        ],
      },
    ],
  });

  it("turns staggered rows of logo badges into flex rows without left/top", () => {
    const content = frame({
      name: "Content",
      absoluteBoundingBox: box(1158, 498),
      children: [
        badge(1, 553, 0, 1, 4),
        badge(2, 921, 0),
        badge(3, 369, 261, 0, 6),
        badge(4, 737, 261),
        badge(5, 185, 0),
        badge(6, 0, 261),
      ],
    });
    const { code } = convertNode(content, { absolutePositioning: true, inferLayout: true });
    expect(code).not.toMatch(/\babsolute\b/);
    expect(code).not.toMatch(/left-\[|top-\[/);
    expect(code).toContain("flex-col");
    expect(code).toContain("gap-[24px]");
    expect(code).toContain("pl-[185px]");
    expect(code).toContain("rounded-full");
    expect(code).toContain("justify-center");
    // The wrapper groups are gone: no leftover full-size boxes.
    expect(code).not.toContain('data-name="Inner"');
  });

  it("ignores Figma's inferred row when a child is a backdrop", () => {
    const b = badge(7, 0, 0, 1, 4);
    const inner = b.children![0];
    const g: FigmaNode = {
      ...b,
      children: inner.children,
      inferredLayout: { layoutMode: "HORIZONTAL", counterAxisAlignItems: "CENTER" },
    };
    const { code } = convertNode(g, { absolutePositioning: true, inferLayout: true });
    expect(code).toContain("rounded-full");
    expect(code).toContain("justify-center");
    expect(code).not.toContain('data-name="Ellipse"');
    expect(code).not.toMatch(/\babsolute\b/);
  });

  it("stacks a heading above its content instead of pinning both", () => {
    const sel = frame({
      name: "Selection",
      type: "GROUP",
      absoluteBoundingBox: box(1340, 356),
      children: [
        frame({ id: "h", name: "Heading", absoluteBoundingBox: box(1340, 24, 0, 0) }),
        frame({ id: "c", name: "Content", absoluteBoundingBox: box(1340, 289, 0, 67) }),
      ],
    });
    const { code } = convertNode(sel, { absolutePositioning: true, inferLayout: true });
    expect(code).toContain("flex-col");
    expect(code).toContain("gap-[43px]");
    expect(code).not.toMatch(/\babsolute\b/);
  });

  it("places two diagonal siblings by margins, not left/top", () => {
    const n = frame({
      absoluteBoundingBox: box(400, 400),
      children: [
        frame({ id: "a", absoluteBoundingBox: box(100, 100, 0, 0) }),
        frame({ id: "b", absoluteBoundingBox: box(100, 100, 250, 250) }),
      ],
    });
    const { code } = convertNode(n, { absolutePositioning: true, inferLayout: true });
    expect(code).not.toMatch(/\babsolute\b/);
    expect(code).toContain("ml-[250px]");
    expect(code).toContain("gap-[150px]");
  });

  it("cuts a free-form section into bands and keeps absolute only in the diagram", () => {
    const text = (id: string, x: number, y: number, w: number, h: number): FigmaNode => ({
      id, name: id, type: "TEXT", characters: id, absoluteBoundingBox: box(w, h, x, y),
    });
    const content = frame({
      id: "content",
      name: "Content",
      absoluteBoundingBox: box(1340, 582, 0, 91),
      children: [
        frame({ id: "l1", name: "Label1", layoutMode: "HORIZONTAL", absoluteBoundingBox: box(455, 52, 0, 91), children: [text("t1", 20, 103, 415, 28)] }),
        frame({ id: "l2", name: "Label2", layoutMode: "HORIZONTAL", absoluteBoundingBox: box(217, 52, 730, 91), children: [text("t2", 750, 103, 177, 28)] }),
        text("p1", 0, 145, 610, 44),
        text("p2", 730, 145, 610, 22),
        // diagram: overlapping circles and lines
        frame({ id: "c1", name: "Circle1", absoluteBoundingBox: box(225, 225, 56, 278) }),
        frame({ id: "c2", name: "Circle2", absoluteBoundingBox: box(225, 225, 365, 363) }),
        { id: "ln", name: "Line", type: "VECTOR", absoluteBoundingBox: box(1, 444, 0, 228) },
        { id: "ln2", name: "Line2", type: "VECTOR", absoluteBoundingBox: box(365, 1, 0, 588) },
      ],
    });
    const label = frame({
      id: "l3", name: "Label3", layoutMode: "HORIZONTAL",
      absoluteBoundingBox: box(363, 52, 0, 228), children: [text("t3", 20, 240, 323, 28)],
    });
    const sel = frame({
      id: "sel", name: "Selection", type: "GROUP",
      absoluteBoundingBox: box(1340, 673),
      children: [
        frame({
          id: "sec", name: "Section", layoutMode: "VERTICAL", itemSpacing: 43,
          absoluteBoundingBox: box(1340, 673),
          children: [text("h", 0, 0, 600, 48), content],
        }),
        label,
      ],
    });
    const { code } = convertNode(sel, { absolutePositioning: true, inferLayout: true });
    // The label moved into Content; no -z-10 backdrop hack at the top.
    expect(code).not.toContain("-z-10");
    // Headings band flows; the two text columns are side by side via flex.
    expect(code).not.toMatch(/absolute left-\[730px\]/);
    expect(code).not.toMatch(/absolute left-\[0px\] top-\[54px\]/);
    // The overlapping diagram is still free-form.
    expect(code).toMatch(/\babsolute\b/);
  });

  it("drops empty layers and one-child groups inside a free-form frame", () => {
    const n = frame({
      id: "land",
      name: "Landing",
      absoluteBoundingBox: box(377, 265),
      clipsContent: true,
      children: [
        { id: "r", name: "Rectangle 2421", type: "RECTANGLE", cornerRadius: 10, absoluteBoundingBox: box(377, 265) },
        {
          id: "g", name: "Group 8443", type: "GROUP", absoluteBoundingBox: box(377, 284),
          children: [
            { id: "e", name: "image 156", type: "RECTANGLE", rotation: 90, absoluteBoundingBox: box(293, 183, 42, 50) },
            {
              id: "img", name: "laptop", type: "RECTANGLE",
              fills: [{ type: "IMAGE", scaleMode: "FILL" }] as FigmaNode["fills"],
              absoluteBoundingBox: box(377, 284),
            },
          ],
        },
      ],
    });
    const { code } = convertNode(n, { absolutePositioning: true, inferLayout: true });
    expect(code).not.toMatch(/\babsolute\b/);
    expect(code).not.toContain("Rectangle 2421");
    expect(code).not.toContain("image 156");
    expect(code).toContain("<img");
  });

  it("ignores a no-op 90° turn on a circle and centres the logo", () => {
    const g: FigmaNode = {
      id: "g8424", name: "Group 8424", type: "GROUP", absoluteBoundingBox: box(100, 100),
      children: [
        {
          id: "g8312", name: "Group 8312", type: "GROUP", absoluteBoundingBox: box(100, 100),
          children: [
            {
              id: "r1182", name: "Rectangle 1182", type: "RECTANGLE", rotation: 90, cornerRadius: 294,
              fills: [{ type: "SOLID", color: { r: 0.1, g: 0.1, b: 0.1, a: 1 } }] as FigmaNode["fills"],
              absoluteBoundingBox: box(100, 100),
            },
          ],
        },
        { id: "logo", name: "logo", type: "GROUP", absoluteBoundingBox: box(69, 11, 16, 44), children: [{ id: "logov", name: "v", type: "VECTOR", absoluteBoundingBox: box(69, 11, 16, 44) }] },
      ],
    };
    const { code } = convertNode(g, { absolutePositioning: true, inferLayout: true });
    expect(code).not.toMatch(/\babsolute\b/);
    expect(code).not.toContain("rotate-");
    expect(code).toContain("rounded-[294px]");
    expect(code).toContain("justify-center");
  });

  it("drops an empty group next to a logo", () => {
    const g: FigmaNode = {
      id: "g8429", name: "Group 8429", type: "GROUP", absoluteBoundingBox: box(100, 100),
      children: [
        { id: "e", name: "Group 8312", type: "GROUP", absoluteBoundingBox: box(100, 100), children: [] },
        { id: "logo", name: "logo", type: "VECTOR", absoluteBoundingBox: box(72, 21, 14, 39.5) },
      ],
    };
    const { code } = convertNode(g, { absolutePositioning: true, inferLayout: true });
    expect(code).not.toMatch(/\babsolute\b/);
    expect(code).not.toContain("Group 8312");
  });

  it("stacks centred overlapping layers in one grid cell", () => {
    const orange = [{ type: "SOLID", color: { r: 1, g: 0.4, b: 0, a: 1 } }] as FigmaNode["fills"];
    const card = frame({
      id: "land", name: "Landing", absoluteBoundingBox: box(317, 223),
      children: [
        { id: "bg", name: "Rectangle 2421", type: "RECTANGLE", cornerRadius: 8, fills: orange, absoluteBoundingBox: box(317, 223) },
        { id: "burst", name: "burst", type: "GROUP", absoluteBoundingBox: box(223, 223, 47, 0), children: [{ id: "burstv", name: "v", type: "VECTOR", absoluteBoundingBox: box(223, 223, 47, 0) }] },
        { id: "icon", name: "icon", type: "GROUP", absoluteBoundingBox: box(69, 101, 125, 61), children: [{ id: "iconv", name: "v", type: "VECTOR", absoluteBoundingBox: box(69, 101, 125, 61) }] },
      ],
    });
    const { code, cssModule } = convertNode(card, { absolutePositioning: true, inferLayout: true });
    expect(code).not.toMatch(/\babsolute\b/);
    expect(code).toContain("grid place-items-center");
    expect(code).toContain("col-start-1 row-start-1");
    expect(code).toContain("rounded-[8px]");
    expect(cssModule.css ?? JSON.stringify(cssModule)).toContain("place-items");
  });

  it("never puts flex classes on an exported <img>", () => {
    const icon = frame({
      id: "i1",
      name: "logo",
      layoutMode: "VERTICAL",
      itemSpacing: 15,
      absoluteBoundingBox: box(154, 100),
      children: [{ id: "i2", name: "v", type: "VECTOR", absoluteBoundingBox: box(50, 50) }],
    });
    const { code } = convertNode(icon, { absolutePositioning: true });
    expect(code).toContain("<img");
    expect(code).not.toContain("flex-col");
  });
});

describe("interactive states (prototype hover / press)", () => {
  const solid = (r: number, g: number, b: number) => [{ type: "SOLID", color: { r, g, b, a: 1 } }];
  const label = (color: [number, number, number], x = 0) =>
    ({
      id: "t",
      name: "Label",
      type: "TEXT",
      characters: "Купить",
      absoluteBoundingBox: box(60, 20, x + 20, 14),
      style: { fontSize: 14, fontWeight: 700, lineHeightPx: 20 },
      fills: solid(...color),
    }) as unknown as FigmaNode;
  const button = (over: Partial<FigmaNode>) =>
    frame({
      id: "b",
      name: "Button",
      layoutMode: "HORIZONTAL",
      paddingLeft: 20,
      paddingRight: 20,
      paddingTop: 14,
      paddingBottom: 14,
      absoluteBoundingBox: box(100, 48),
      fills: solid(1, 1, 1),
      children: [label([0, 0, 0])],
      ...over,
    });

  // The variant lives elsewhere on the canvas — position must not leak into the diff.
  const hoverVariant = button({
    id: "v",
    absoluteBoundingBox: box(100, 48, 900, 500),
    fills: solid(0, 0, 0),
    children: [label([1, 1, 1], 900)],
  });
  const btn = button({
    interactiveStates: [
      { trigger: "hover", node: hoverVariant, transition: { duration: 300, easing: "cubic-bezier(0,0,0.58,1)" } },
    ],
  });

  it("emits only the changed utilities, prefixed, with Figma's timing", () => {
    const { html } = convertNode(btn);
    expect(html).toContain("hover:bg-[#000000]");
    expect(html).toContain("group-hover:text-[#ffffff]");
    expect(html).toMatch(/class="[^"]*\bgroup\b/);
    expect(html).toContain("duration-[300ms]");
    expect(html).toContain("ease-out");
    expect(html).not.toMatch(/hover:(left|top|w|h|p[xy]?)-/);
  });

  it("maps press to active:", () => {
    const n = button({ interactiveStates: [{ trigger: "press", node: hoverVariant }] });
    expect(convertNode(n).html).toContain("active:bg-[#000000]");
  });

  it("writes :hover rules in the CSS-modules output", () => {
    const css = convertNode(btn).cssModule.css;
    expect(css).toMatch(/:hover \{[^}]*background/);
    expect(css).toMatch(/:hover \.\w+ \{[^}]*color/);
    expect(css).toContain("transition-duration: 300ms");
  });

  it("leaves a node without states untouched", () => {
    expect(convertNode(button({})).html).not.toContain("hover:");
  });
});

describe("auto animation (After delay → Change to)", () => {
  const dot = (opacity: number, x = 0) =>
    ({
      id: "d",
      name: "Dot",
      type: "FRAME",
      absoluteBoundingBox: box(10, 10, x, 0),
      fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }],
      ...(opacity < 1 ? { opacity } : {}),
    }) as unknown as FigmaNode;
  const loader = (steps: NonNullable<FigmaNode["autoAnimation"]>["steps"], loops: boolean) =>
    frame({
      id: "l",
      name: "Loader",
      layoutMode: "HORIZONTAL",
      absoluteBoundingBox: box(10, 10),
      children: [dot(1)],
      autoAnimation: { steps, loops },
    });
  const dim = frame({ id: "v", name: "Loader", layoutMode: "HORIZONTAL", absoluteBoundingBox: box(10, 10, 500, 0), children: [dot(0.2, 500)] });

  it("turns a looping chain into infinite keyframes on the changing element", () => {
    const n = loader(
      [
        { delay: 500, duration: 300, easing: "cubic-bezier(0,0,0.58,1)", node: dim },
        { delay: 500, duration: 300, node: null },
      ],
      true,
    );
    const { html, code } = convertNode(n);
    expect(html).toContain("<style>");
    expect(html).toMatch(/@keyframes fx-1 \{[\s\S]*opacity: 0\.2/);
    expect(html).toContain("animate-[fx-1_1600ms_linear_infinite]");
    // 500ms hold of 1600ms → the first move starts at 31.25%
    expect(html).toContain("31.25% { opacity: 1; animation-timing-function: cubic-bezier(0,0,0.58,1); }");
    expect(code).toContain("<style>{`");
  });

  it("plays a one-way chain once and stays on the last state", () => {
    const n = loader([{ delay: 0, duration: 400, node: dim }], false);
    const { html } = convertNode(n);
    expect(html).toContain("animate-[fx-1_400ms_linear_1_forwards]");
    expect(html).toMatch(/100% \{ opacity: 0\.2;/);
  });

  it("puts the keyframes into the CSS module", () => {
    const n = loader([{ delay: 0, duration: 400, node: dim }], false);
    const { cssModule } = convertNode(n);
    expect(cssModule.css).toContain("@keyframes fx-1");
    expect(cssModule.css).toContain("animation: fx-1 400ms linear 1 forwards");
  });
});

describe("auto animation: spinner made of rotated variants", () => {
  // An arc exported as SVG, turned 90° per variant (Figma keeps -180..180).
  const arc = (rotation: number, x: number) =>
    ({
      id: `arc${x}`,
      name: "Ellipse 6",
      type: "ELLIPSE",
      rotation,
      svgExport: true,
      absoluteBoundingBox: box(rotation % 180 ? 100 : 100, 100, x, 0),
      strokes: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }],
    }) as unknown as FigmaNode;
  const variant = (rotation: number, x: number) =>
    frame({ id: `v${x}`, name: "loading", layoutMode: "HORIZONTAL", absoluteBoundingBox: box(100, 100, x, 0), children: [arc(rotation, x)] });
  const step = (node: FigmaNode | null) => ({ delay: 1, duration: 300, easing: "linear", node });

  it("spins one full turn per cycle instead of tweening the box", () => {
    const n = frame({
      id: "l",
      name: "loading",
      layoutMode: "HORIZONTAL",
      absoluteBoundingBox: box(100, 100),
      children: [arc(0, 0)],
      autoAnimation: {
        loops: true,
        steps: [step(variant(90, 200)), step(variant(180, 400)), step(variant(-90, 600)), step(null)],
      },
    });
    const { html } = convertNode(n);
    const kf = html.match(/@keyframes fx-1 \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(kf).toContain("rotate: 0deg");
    expect(kf).toContain("rotate: 90deg");
    expect(kf).toContain("rotate: 270deg");
    expect(kf).toMatch(/100% \{ rotate: 360deg; \}/);
    expect(kf).not.toMatch(/\b(left|top|width|height):/);
  });
});
