import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  ArchitectureRegistry,
  SDK_ARCHITECTURE_LAYERS,
  SDK_DESIGN_DECISIONS,
  SDK_DIAGRAMS,
  SDK_API_CATALOG,
  SDK_EXTENSION_POINTS,
  SDK_REFERENCES,
  validateArchitectureCatalog,
} from "../src/architectureRegistry.js";

describe("SDK Architecture Documentation & Registry (#1199)", () => {
  const repoRoot = path.resolve(__dirname, "..");
  const archMdPath = path.join(repoRoot, "ARCHITECTURE.md");
  const archGuidePath = path.join(repoRoot, "docs", "ARCHITECTURE_GUIDE.md");

  it("validates the programmatic architecture catalog with zero errors", () => {
    const report = validateArchitectureCatalog();
    expect(report.valid).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.layerCount).toBe(6);
    expect(report.moduleCount).toBeGreaterThanOrEqual(12);
    expect(report.decisionCount).toBeGreaterThanOrEqual(6);
    expect(report.diagramCount).toBeGreaterThanOrEqual(3);
    expect(report.apiEntryCount).toBe(8);
    expect(report.extensionPointCount).toBeGreaterThanOrEqual(6);
    expect(report.referenceCount).toBeGreaterThanOrEqual(9);
  });

  it("maps all 6 architectural layers in strict downward order", () => {
    const registry = new ArchitectureRegistry();
    const layers = registry.getLayers();

    expect(layers.map((l) => l.order)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(registry.getLayerById("client-orchestration")?.title).toContain(
      "Client Orchestration",
    );
    expect(registry.getLayerById("resilience-transport")?.modules.length).toBeGreaterThanOrEqual(
      3,
    );
  });

  it("documents architectural design decisions (ADRs) with context, decision, and consequences", () => {
    for (const adr of SDK_DESIGN_DECISIONS) {
      expect(adr.id).toMatch(/^ADR-\d{3}$/);
      expect(adr.status).toBe("accepted");
      expect(adr.context.length).toBeGreaterThan(20);
      expect(adr.decision.length).toBeGreaterThan(20);
      expect(adr.consequences.length).toBeGreaterThanOrEqual(2);
      expect(adr.relatedModules.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("includes helpful Mermaid diagrams for system layers, transaction sequence, and circuit breaker state", () => {
    const diagramTypes = SDK_DIAGRAMS.map((d) => d.diagramType);
    expect(diagramTypes).toContain("flowchart");
    expect(diagramTypes).toContain("sequenceDiagram");
    expect(diagramTypes).toContain("stateDiagram-v2");
  });

  it("documents all 8 package.json subpath API entrypoints", () => {
    const pkgJson = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    );
    const exportedSubpaths = Object.keys(pkgJson.exports).map((key) =>
      key === "." ? "@stellar-split/sdk" : `@stellar-split/sdk/${key.replace(/^\.\//, "")}`,
    );

    const documentedSubpaths = SDK_API_CATALOG.map((entry) => entry.subpath);
    for (const subpath of exportedSubpaths) {
      expect(documentedSubpaths).toContain(subpath);
    }
  });

  it("explains extension points with lifecycle hooks and working TypeScript examples", () => {
    const extensionIds = SDK_EXTENSION_POINTS.map((e) => e.id);
    expect(extensionIds).toEqual(
      expect.arrayContaining([
        "ext-sdk-plugin",
        "ext-telemetry-hooks",
        "ext-wallet-signer",
        "ext-request-interceptors",
        "ext-custom-health-check",
        "ext-upgrade-migration",
      ]),
    );

    for (const ext of SDK_EXTENSION_POINTS) {
      expect(ext.lifecycleHooks.length).toBeGreaterThan(0);
      expect(ext.exampleCode).toContain("@stellar-split/sdk");
    }
  });

  it("verifies internal documentation references exist on disk and external references are valid URLs", () => {
    for (const ref of SDK_REFERENCES) {
      if (ref.category === "internal-doc") {
        const fullPath = path.join(repoRoot, ref.pathOrUrl);
        expect(fs.existsSync(fullPath)).toBe(true);
      } else if (ref.category === "stellar-sep" || ref.category === "external-spec") {
        expect(ref.pathOrUrl).toMatch(/^https:\/\//);
      }
    }
  });

  it("verifies ARCHITECTURE.md and docs/ARCHITECTURE_GUIDE.md contain all required sections", () => {
    expect(fs.existsSync(archMdPath)).toBe(true);
    expect(fs.existsSync(archGuidePath)).toBe(true);

    const archMd = fs.readFileSync(archMdPath, "utf8");
    expect(archMd).toContain("## 1. Architectural Overview & 6-Layer Map");
    expect(archMd).toContain("## 2. System & Sequence Diagrams");
    expect(archMd).toContain("```mermaid");
    expect(archMd).toContain("## 3. Design Decisions (Architecture Decision Records)");
    expect(archMd).toContain("## 4. Request Deduplication for Idempotency");
    expect(archMd).toContain("## 5. Public API Surface & Subpath Entrypoints");
    expect(archMd).toContain("## 6. Extension Points & Customization Guide");
    expect(archMd).toContain("## 7. References & Specifications");
  });
});
