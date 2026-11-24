import { describe, expect, it } from 'vitest';
import { ApiDocGenerator } from '../src/apiDocGenerator.js';

const source = `
/** Runs a task.
 * @param {string} name - Task name
 * @returns Task result
 * @example
 * runTask("build")
 * @since 1.2.0
 * @throws {Error} - <failure>
 */
export function runTask(name: string): string {
  return name;
}

/** An old helper.
 * @deprecated Use runTask instead.
 */
export const oldTask = () => {};

/** A task runner. */
export class TaskRunner {}

/** Configuration for a task. */
export interface TaskConfig {}

/** A task name. */
export type TaskName = string;
`;

describe('ApiDocGenerator', () => {
  it('parses exported declaration kinds and JSDoc metadata', () => {
    const generator = new ApiDocGenerator({ version: '1.2.0', sources: { tasks: source } });
    const entries = generator.getEntries();

    expect(entries.map(({ name, kind }) => [name, kind])).toEqual([
      ['runTask', 'function'],
      ['oldTask', 'function'],
      ['TaskRunner', 'class'],
      ['TaskConfig', 'interface'],
      ['TaskName', 'type'],
    ]);
    expect(generator.getEntry('tasks/runTask')).toMatchObject({
      description: 'Runs a task.',
      params: [{ name: 'name', type: 'string', description: 'Task name', optional: false }],
      returns: 'Task result',
      examples: ['runTask("build")'],
      since: '1.2.0',
    });
  });

  it('generates customized Markdown, HTML, and JSON references', () => {
    const generator = new ApiDocGenerator({
      version: '1.2.0',
      sources: { tasks: source },
      categories: { tasks: 'Task Management' },
      title: 'SDK Reference',
    });

    const markdown = generator.generate('markdown');
    expect(markdown).toContain('# SDK Reference');
    expect(markdown).toContain('## Task Management');
    expect(markdown).toContain('#### runTask');
    expect(markdown).toContain('### Parameters');
    expect(markdown).toContain('Since: 1.2.0');
    expect(markdown).toContain('@throws');

    const html = generator.generate('html');
    expect(html).toContain('<title>SDK Reference</title>');
    expect(html).toContain('<h2>Task Management</h2>');
    expect(html).toContain('<nav aria-label="API navigation">');
    expect(html).toContain('<article id="tasks/runTask">');
    expect(html).toContain('<code>runTask(&quot;build&quot;)</code>');
    expect(html).toContain('&lt;failure&gt;');

    const manifest = JSON.parse(generator.generate('json')) as {
      version: string;
      entries: Record<string, { name: string }>;
      navigation: { children: Array<{ label: string }> };
    };
    expect(manifest.version).toBe('1.2.0');
    expect(manifest.entries['tasks/runTask']?.name).toBe('runTask');
    expect(manifest.navigation.children[0]?.label).toBe('Task Management');
  });

  it('excludes deprecated entries when configured', () => {
    const generator = new ApiDocGenerator({
      version: '1.2.0',
      sources: { tasks: source },
      includeDeprecated: false,
    });

    expect(generator.getEntry('tasks/oldTask')).toBeUndefined();
    expect(generator.generate('markdown')).not.toContain('oldTask');
    expect(JSON.parse(generator.generate('json')).entries['tasks/oldTask']).toBeUndefined();
  });
});
