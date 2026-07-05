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

  it("reports a warning for an angular gradient", () => {
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
    const { warnings } = convertNode(n);
    expect(warnings?.some((w) => /GRADIENT_ANGULAR/.test(w))).toBe(true);
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
