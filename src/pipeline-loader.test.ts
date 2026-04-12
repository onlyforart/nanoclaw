import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  _initTestDatabase,
  createTask,
  getTaskById,
  setRegisteredGroup,
} from './db.js';
import {
  loadPipelineSpec,
  reconcilePipelineTasks,
} from './pipeline-loader.js';

let tmpDir: string;

beforeEach(() => {
  _initTestDatabase();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-'));
});

function writeYaml(filename: string, content: string): string {
  const filePath = path.join(tmpDir, filename);
  fs.writeFileSync(filePath, content);
  return filePath;
}

// --- loadPipelineSpec ---

describe('loadPipelineSpec', () => {
  it('parses a valid pipeline YAML spec', () => {
    const filePath = writeYaml(
      'sanitiser.yaml',
      `
name: sanitiser
description: Extracts structured observations
version: 1
model: anthropic:haiku
cron: "*/1 * * * *"
system: |-
  You are a structured data extractor.
tools:
  default_enabled: false
  enabled: []
send_targets: []
`,
    );

    const spec = loadPipelineSpec(filePath);
    expect(spec.name).toBe('sanitiser');
    expect(spec.version).toBe(1);
    expect(spec.model).toBe('anthropic:haiku');
    expect(spec.cron).toBe('*/1 * * * *');
    expect(spec.system).toContain('structured data extractor');
    expect(spec.tools.enabled).toEqual([]);
    expect(spec.send_targets).toEqual([]);
  });

  it('parses a spec with tools and send_targets', () => {
    const filePath = writeYaml(
      'monitor.yaml',
      `
name: monitor
description: Clusters observations
version: 1
model: anthropic:haiku
cron: "*/2 * * * *"
subscribed_event_types:
  - "observation.*"
system: You are a triage classifier.
tools:
  default_enabled: false
  enabled:
    - consume_events
    - publish_event
send_targets: []
`,
    );

    const spec = loadPipelineSpec(filePath);
    expect(spec.tools.enabled).toEqual(['consume_events', 'publish_event']);
    expect(spec.subscribed_event_types).toEqual(['observation.*']);
  });

  it('parses a spec with type: host_pipeline', () => {
    const filePath = writeYaml(
      'sanitiser.yaml',
      `
name: sanitiser
description: test
version: 1
type: host_pipeline
model: anthropic:haiku
cron: "*/1 * * * *"
system: test
tools:
  default_enabled: false
  enabled: []
send_targets: []
`,
    );

    const spec = loadPipelineSpec(filePath);
    expect(spec.type).toBe('host_pipeline');
  });

  it('rejects a spec missing required fields', () => {
    const filePath = writeYaml(
      'bad.yaml',
      `
name: incomplete
version: 1
`,
    );

    expect(() => loadPipelineSpec(filePath)).toThrow();
  });
});

// --- reconcilePipelineTasks ---

describe('reconcilePipelineTasks', () => {
  it('creates a new task from a pipeline spec', () => {
    const specs = [
      {
        name: 'monitor',
        description: 'Clusters observations',
        version: 1,
        model: 'anthropic:haiku',
        cron: '*/2 * * * *',
        system: 'You are a triage classifier.',
        tools: { default_enabled: false, enabled: ['consume_events'] },
        send_targets: [],
        subscribed_event_types: ['observation.*'],
      },
    ];

    reconcilePipelineTasks(specs, 'slack_main', 'slack:CMAIN');

    const task = getTaskById('pipeline:monitor');
    expect(task).toBeDefined();
    expect(task!.prompt).toContain('triage classifier');
    expect(task!.allowedTools).toEqual(['consume_events']);
    expect(task!.allowedSendTargets).toEqual([]);
  });

  it('updates a task when spec version is higher', () => {
    const specs = [
      {
        name: 'monitor',
        description: 'Clusters observations',
        version: 1,
        model: 'anthropic:haiku',
        cron: '*/2 * * * *',
        system: 'Version 1 prompt.',
        tools: { default_enabled: false, enabled: [] },
        send_targets: [],
      },
    ];

    reconcilePipelineTasks(specs, 'slack_main', 'slack:CMAIN');

    // Bump version
    specs[0].version = 2;
    specs[0].system = 'Version 2 prompt.';

    reconcilePipelineTasks(specs, 'slack_main', 'slack:CMAIN');

    const task = getTaskById('pipeline:monitor');
    expect(task!.prompt).toContain('Version 2');
  });

  it('no-ops when spec version matches existing', () => {
    const specs = [
      {
        name: 'solver',
        description: 'Investigates escalations',
        version: 1,
        model: 'anthropic:sonnet',
        cron: '*/5 * * * *',
        system: 'Original prompt.',
        tools: { default_enabled: false, enabled: [] },
        send_targets: [],
      },
    ];

    reconcilePipelineTasks(specs, 'slack_main', 'slack:CMAIN');

    // Call again with same version but different system (should NOT update)
    const modified = [{ ...specs[0], system: 'Changed but same version.' }];
    reconcilePipelineTasks(modified, 'slack_main', 'slack:CMAIN');

    const task = getTaskById('pipeline:solver');
    expect(task!.prompt).toContain('Original prompt');
  });

  it('sets execution_mode to host_pipeline for type: host_pipeline specs', () => {
    const specs = [
      {
        name: 'sanitiser',
        description: 'Sanitises messages',
        version: 1,
        type: 'host_pipeline' as const,
        model: 'anthropic:haiku',
        cron: '*/1 * * * *',
        system: 'Extract fields.',
        tools: { default_enabled: false, enabled: [] },
        send_targets: [],
      },
    ];

    reconcilePipelineTasks(specs, 'slack_main', 'slack:CMAIN');

    const task = getTaskById('pipeline:sanitiser');
    expect(task).toBeDefined();
    expect(task!.executionMode).toBe('host_pipeline');
  });

  it('stores subscribed_event_types from the spec', () => {
    const specs = [
      {
        name: 'sanitiser',
        description: 'test',
        version: 1,
        model: 'anthropic:haiku',
        cron: '*/1 * * * *',
        system: 'test',
        tools: { default_enabled: false, enabled: [] },
        send_targets: [],
        subscribed_event_types: ['intake.raw'],
      },
    ];

    reconcilePipelineTasks(specs, 'slack_main', 'slack:CMAIN');

    const task = getTaskById('pipeline:sanitiser');
    expect(task!.subscribedEventTypes).toEqual(['intake.raw']);
  });

  it('resolves {source_channel} placeholders from passive groups', () => {
    setRegisteredGroup('slack:CPASSIVE', {
      name: 'Passive Channel',
      folder: 'slack_passive',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      mode: 'passive',
    });

    const specs = [
      {
        name: 'responder',
        description: 'Delivers replies',
        version: 1,
        model: 'anthropic:haiku',
        cron: '*/1 * * * *',
        system: 'Deliver approved replies.',
        tools: { default_enabled: false, enabled: ['send_cross_channel_message'] },
        send_targets: ['{source_channel}'],
      },
    ];

    reconcilePipelineTasks(specs, 'slack_main', 'slack:CMAIN');

    const task = getTaskById('pipeline:responder');
    expect(task!.allowedSendTargets).toContain('slack:CPASSIVE');
  });
});
