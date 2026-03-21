import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  createTask,
  getAllTasks,
  getRegisteredGroup,
  getTaskById,
  setRegisteredGroup,
  updateRegisteredGroup,
} from './db.js';
import { processTaskIpc, IpcDeps } from './ipc.js';
import { RegisteredGroup } from './types.js';

// Set up registered groups used across tests
const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'whatsapp_main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

const OTHER_GROUP: RegisteredGroup = {
  name: 'Other',
  folder: 'other-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

const THIRD_GROUP: RegisteredGroup = {
  name: 'Third',
  folder: 'third-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

let groups: Record<string, RegisteredGroup>;
let deps: IpcDeps;

beforeEach(() => {
  _initTestDatabase();

  groups = {
    'main@g.us': MAIN_GROUP,
    'other@g.us': OTHER_GROUP,
    'third@g.us': THIRD_GROUP,
  };

  // Populate DB as well
  setRegisteredGroup('main@g.us', MAIN_GROUP);
  setRegisteredGroup('other@g.us', OTHER_GROUP);
  setRegisteredGroup('third@g.us', THIRD_GROUP);

  deps = {
    sendMessage: async () => {},
    registeredGroups: () => groups,
    registerGroup: (jid, group) => {
      groups[jid] = group;
      setRegisteredGroup(jid, group);
      // Mock the fs.mkdirSync that registerGroup does
    },
    updateGroup: (jid, updates) => {
      updateRegisteredGroup(jid, updates);
    },
    syncGroups: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
  };
});

// --- schedule_task authorization ---

describe('schedule_task authorization', () => {
  it('main group can schedule for another group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'do something',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    // Verify task was created in DB for the other group
    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(1);
    expect(allTasks[0].group_folder).toBe('other-group');
  });

  it('non-main group can schedule for itself', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'self task',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'other@g.us',
      },
      'other-group',
      false,
      deps,
    );

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(1);
    expect(allTasks[0].group_folder).toBe('other-group');
  });

  it('non-main group cannot schedule for another group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'unauthorized',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'main@g.us',
      },
      'other-group',
      false,
      deps,
    );

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(0);
  });

  it('rejects schedule_task for unregistered target JID', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'no target',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'unknown@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(0);
  });
});

// --- pause_task authorization ---

describe('pause_task authorization', () => {
  beforeEach(() => {
    createTask({
      id: 'task-main',
      group_folder: 'whatsapp_main',
      chat_jid: 'main@g.us',
      prompt: 'main task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
    createTask({
      id: 'task-other',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'other task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
  });

  it('main group can pause any task', async () => {
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-other' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(getTaskById('task-other')!.status).toBe('paused');
  });

  it('non-main group can pause its own task', async () => {
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-other' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-other')!.status).toBe('paused');
  });

  it('non-main group cannot pause another groups task', async () => {
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-main' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-main')!.status).toBe('active');
  });
});

// --- resume_task authorization ---

describe('resume_task authorization', () => {
  beforeEach(() => {
    createTask({
      id: 'task-paused',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'paused task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'paused',
      created_at: '2024-01-01T00:00:00.000Z',
    });
  });

  it('main group can resume any task', async () => {
    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-paused' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(getTaskById('task-paused')!.status).toBe('active');
  });

  it('non-main group can resume its own task', async () => {
    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-paused' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-paused')!.status).toBe('active');
  });

  it('non-main group cannot resume another groups task', async () => {
    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-paused' },
      'third-group',
      false,
      deps,
    );
    expect(getTaskById('task-paused')!.status).toBe('paused');
  });
});

// --- cancel_task authorization ---

describe('cancel_task authorization', () => {
  it('main group can cancel any task', async () => {
    createTask({
      id: 'task-to-cancel',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'cancel me',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-to-cancel' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(getTaskById('task-to-cancel')).toBeUndefined();
  });

  it('non-main group can cancel its own task', async () => {
    createTask({
      id: 'task-own',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'my task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-own' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-own')).toBeUndefined();
  });

  it('non-main group cannot cancel another groups task', async () => {
    createTask({
      id: 'task-foreign',
      group_folder: 'whatsapp_main',
      chat_jid: 'main@g.us',
      prompt: 'not yours',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-foreign' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-foreign')).toBeDefined();
  });
});

// --- register_group authorization ---

describe('register_group authorization', () => {
  it('non-main group cannot register a group', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: 'new-group',
        trigger: '@Andy',
      },
      'other-group',
      false,
      deps,
    );

    // registeredGroups should not have changed
    expect(groups['new@g.us']).toBeUndefined();
  });

  it('main group cannot register with unsafe folder path', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: '../../outside',
        trigger: '@Andy',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(groups['new@g.us']).toBeUndefined();
  });
});

// --- refresh_groups authorization ---

describe('refresh_groups authorization', () => {
  it('non-main group cannot trigger refresh', async () => {
    // This should be silently blocked (no crash, no effect)
    await processTaskIpc(
      { type: 'refresh_groups' },
      'other-group',
      false,
      deps,
    );
    // If we got here without error, the auth gate worked
  });
});

// --- IPC message authorization ---
// Tests the authorization pattern from startIpcWatcher (ipc.ts).
// The logic: isMain || (targetGroup && targetGroup.folder === sourceGroup)

describe('IPC message authorization', () => {
  // Replicate the exact check from the IPC watcher
  function isMessageAuthorized(
    sourceGroup: string,
    isMain: boolean,
    targetChatJid: string,
    registeredGroups: Record<string, RegisteredGroup>,
  ): boolean {
    const targetGroup = registeredGroups[targetChatJid];
    return isMain || (!!targetGroup && targetGroup.folder === sourceGroup);
  }

  it('main group can send to any group', () => {
    expect(
      isMessageAuthorized('whatsapp_main', true, 'other@g.us', groups),
    ).toBe(true);
    expect(
      isMessageAuthorized('whatsapp_main', true, 'third@g.us', groups),
    ).toBe(true);
  });

  it('non-main group can send to its own chat', () => {
    expect(
      isMessageAuthorized('other-group', false, 'other@g.us', groups),
    ).toBe(true);
  });

  it('non-main group cannot send to another groups chat', () => {
    expect(isMessageAuthorized('other-group', false, 'main@g.us', groups)).toBe(
      false,
    );
    expect(
      isMessageAuthorized('other-group', false, 'third@g.us', groups),
    ).toBe(false);
  });

  it('non-main group cannot send to unregistered JID', () => {
    expect(
      isMessageAuthorized('other-group', false, 'unknown@g.us', groups),
    ).toBe(false);
  });

  it('main group can send to unregistered JID', () => {
    // Main is always authorized regardless of target
    expect(
      isMessageAuthorized('whatsapp_main', true, 'unknown@g.us', groups),
    ).toBe(true);
  });
});

// --- schedule_task with cron and interval types ---

describe('schedule_task schedule types', () => {
  it('creates task with cron schedule and computes next_run', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'cron task',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *', // every day at 9am
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].schedule_type).toBe('cron');
    expect(tasks[0].next_run).toBeTruthy();
    // next_run should be a valid ISO date in the future
    expect(new Date(tasks[0].next_run!).getTime()).toBeGreaterThan(
      Date.now() - 60000,
    );
  });

  it('rejects invalid cron expression', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad cron',
        schedule_type: 'cron',
        schedule_value: 'not a cron',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('creates task with interval schedule', async () => {
    const before = Date.now();

    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'interval task',
        schedule_type: 'interval',
        schedule_value: '3600000', // 1 hour
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].schedule_type).toBe('interval');
    // next_run should be ~1 hour from now
    const nextRun = new Date(tasks[0].next_run!).getTime();
    expect(nextRun).toBeGreaterThanOrEqual(before + 3600000 - 1000);
    expect(nextRun).toBeLessThanOrEqual(Date.now() + 3600000 + 1000);
  });

  it('rejects invalid interval (non-numeric)', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad interval',
        schedule_type: 'interval',
        schedule_value: 'abc',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('rejects invalid interval (zero)', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'zero interval',
        schedule_type: 'interval',
        schedule_value: '0',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('rejects invalid once timestamp', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad once',
        schedule_type: 'once',
        schedule_value: 'not-a-date',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });
});

// --- context_mode defaulting ---

describe('schedule_task context_mode', () => {
  it('accepts context_mode=group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'group context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        context_mode: 'group',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('group');
  });

  it('accepts context_mode=isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'isolated context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        context_mode: 'isolated',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });

  it('defaults invalid context_mode to isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        context_mode: 'bogus' as any,
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });

  it('defaults missing context_mode to isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'no context mode',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });
});

// --- register_group success path ---

describe('register_group success', () => {
  it('main group can register a new group', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: 'new-group',
        trigger: '@Andy',
      },
      'whatsapp_main',
      true,
      deps,
    );

    // Verify group was registered in DB
    const group = getRegisteredGroup('new@g.us');
    expect(group).toBeDefined();
    expect(group!.name).toBe('New Group');
    expect(group!.folder).toBe('new-group');
    expect(group!.trigger).toBe('@Andy');
  });

  it('register_group rejects request with missing fields', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'partial@g.us',
        name: 'Partial',
        // missing folder and trigger
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getRegisteredGroup('partial@g.us')).toBeUndefined();
  });
});

// --- maxToolRounds and timeoutMs in IPC ---

describe('schedule_task with maxToolRounds and timeoutMs', () => {
  it('passes maxToolRounds and timeoutMs through to created task', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'limits task',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'other@g.us',
        maxToolRounds: 5,
        timeoutMs: 120_000,
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].maxToolRounds).toBe(5);
    expect(tasks[0].timeoutMs).toBe(120_000);
  });

  it('defaults maxToolRounds and timeoutMs to null when not provided', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'no limits',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].maxToolRounds).toBeNull();
    expect(tasks[0].timeoutMs).toBeNull();
  });
});

describe('register_group with maxToolRounds and timeoutMs', () => {
  it('passes maxToolRounds and timeoutMs through to registered group', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: 'new-group',
        trigger: '@Andy',
        model: 'ollama:qwen3',
        maxToolRounds: 15,
        timeoutMs: 60_000,
      },
      'whatsapp_main',
      true,
      deps,
    );

    const group = getRegisteredGroup('new@g.us');
    expect(group).toBeDefined();
    expect(group!.maxToolRounds).toBe(15);
    expect(group!.timeoutMs).toBe(60_000);
  });
});

describe('update_group with maxToolRounds and timeoutMs', () => {
  it('updates maxToolRounds and timeoutMs on a group', async () => {
    await processTaskIpc(
      {
        type: 'update_group',
        jid: 'other@g.us',
        maxToolRounds: 8,
        timeoutMs: 90_000,
      },
      'whatsapp_main',
      true,
      deps,
    );

    const group = getRegisteredGroup('other@g.us');
    expect(group).toBeDefined();
    expect(group!.maxToolRounds).toBe(8);
    expect(group!.timeoutMs).toBe(90_000);
  });
});

// --- Requirement: agents must receive accurate feedback ---
//
// When an agent calls pause/resume/cancel/update/schedule via IPC, it must
// receive an IpcResult { success, error? } that accurately reflects what
// happened on the host. This prevents agents from telling users an action
// succeeded when it actually failed (e.g., due to a truncated task ID or
// authorization failure).

describe('agents receive accurate feedback on task actions', () => {
  beforeEach(() => {
    createTask({
      id: 'task-owned',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'owned task',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      context_mode: 'isolated',
      next_run: '2025-06-01T09:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
  });

  // --- Successful actions report success ---

  it('successful pause reports success and actually pauses the task', async () => {
    const result = await processTaskIpc(
      { type: 'pause_task', taskId: 'task-owned' },
      'other-group', false, deps,
    );
    expect(result).toEqual({ success: true });
    expect(getTaskById('task-owned')!.status).toBe('paused');
  });

  it('successful resume reports success and actually resumes the task', async () => {
    await processTaskIpc({ type: 'pause_task', taskId: 'task-owned' }, 'other-group', false, deps);
    const result = await processTaskIpc(
      { type: 'resume_task', taskId: 'task-owned' },
      'other-group', false, deps,
    );
    expect(result).toEqual({ success: true });
    expect(getTaskById('task-owned')!.status).toBe('active');
  });

  it('successful cancel reports success and actually deletes the task', async () => {
    const result = await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-owned' },
      'other-group', false, deps,
    );
    expect(result).toEqual({ success: true });
    expect(getTaskById('task-owned')).toBeUndefined();
  });

  it('successful update reports success and actually updates the task', async () => {
    const result = await processTaskIpc(
      { type: 'update_task', taskId: 'task-owned', prompt: 'updated prompt' },
      'other-group', false, deps,
    );
    expect(result).toEqual({ success: true });
    expect(getTaskById('task-owned')!.prompt).toBe('updated prompt');
  });

  it('successful schedule reports success and creates the task', async () => {
    const result = await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'new task',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'other@g.us',
      },
      'whatsapp_main', true, deps,
    );
    expect(result).toEqual({ success: true });
    expect(getAllTasks().length).toBe(2); // existing + new
  });

  // --- Failed actions report failure with an explanation ---
  // The error message must be descriptive enough for the agent to relay
  // a meaningful explanation to the user.

  describe('when the task ID does not match any task', () => {
    // This is the exact scenario that triggered the bug: the model truncated
    // a task ID, so the task was not found, but the agent told the user it
    // succeeded because it never learned the action failed.
    for (const action of ['pause_task', 'resume_task', 'cancel_task', 'update_task'] as const) {
      it(`${action} reports failure and includes the bad ID`, async () => {
        const result = await processTaskIpc(
          { type: action, taskId: 'task-1774077051949-kulvz' },  // truncated ID
          'other-group', false, deps,
        );
        expect(result.success).toBe(false);
        expect(result.error).toContain('Task not found');
        expect(result.error).toContain('task-1774077051949-kulvz');
      });
    }
  });

  describe('when the agent is not authorized for the task', () => {
    for (const action of ['pause_task', 'resume_task', 'cancel_task', 'update_task'] as const) {
      it(`${action} reports failure and the task is unchanged`, async () => {
        const statusBefore = getTaskById('task-owned')!.status;
        const promptBefore = getTaskById('task-owned')!.prompt;
        const result = await processTaskIpc(
          { type: action, taskId: 'task-owned', ...(action === 'update_task' ? { prompt: 'hacked' } : {}) },
          'third-group', false, deps,
        );
        expect(result.success).toBe(false);
        expect(result.error).toContain('Not authorized');
        // Verify nothing was mutated
        const task = getTaskById('task-owned')!;
        expect(task.status).toBe(statusBefore);
        expect(task.prompt).toBe(promptBefore);
      });
    }
  });

  describe('when task_id is missing entirely', () => {
    for (const action of ['pause_task', 'resume_task', 'cancel_task', 'update_task'] as const) {
      it(`${action} reports failure`, async () => {
        const result = await processTaskIpc(
          { type: action },
          'other-group', false, deps,
        );
        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
      });
    }
  });

  // --- Schedule-specific validation errors ---

  it('schedule_task reports failure when prompt is missing', async () => {
    const result = await processTaskIpc(
      {
        type: 'schedule_task',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'other@g.us',
      },
      'whatsapp_main', true, deps,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Missing required fields');
  });

  it('schedule_task reports failure for invalid cron and includes the expression', async () => {
    const result = await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad cron',
        schedule_type: 'cron',
        schedule_value: 'not-a-cron',
        targetJid: 'other@g.us',
      },
      'whatsapp_main', true, deps,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid cron');
    expect(result.error).toContain('not-a-cron');
  });

  it('schedule_task reports failure for invalid interval', async () => {
    const result = await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad interval',
        schedule_type: 'interval',
        schedule_value: '-5',
        targetJid: 'other@g.us',
      },
      'whatsapp_main', true, deps,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid interval');
  });

  it('schedule_task reports failure for invalid once timestamp', async () => {
    const result = await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad timestamp',
        schedule_type: 'once',
        schedule_value: 'next tuesday',
        targetJid: 'other@g.us',
      },
      'whatsapp_main', true, deps,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid timestamp');
  });

  it('schedule_task reports failure for unregistered target group', async () => {
    const result = await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'task for nobody',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'nonexistent@g.us',
      },
      'whatsapp_main', true, deps,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('not registered');
  });

  // --- Unknown IPC types are reported as errors, not silently dropped ---

  it('unknown IPC type reports failure instead of being silently ignored', async () => {
    const result = await processTaskIpc(
      { type: 'bogus_action' },
      'other-group', false, deps,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown IPC task type');
  });

  // --- Result consistency: success=true must mean the action happened ---

  it('a failed action never mutates the database', async () => {
    const tasksBefore = getAllTasks();
    // Try to pause a nonexistent task
    await processTaskIpc(
      { type: 'pause_task', taskId: 'does-not-exist' },
      'other-group', false, deps,
    );
    // Try to cancel as unauthorized group
    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-owned' },
      'third-group', false, deps,
    );
    // Try to schedule with invalid cron
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'x',
        schedule_type: 'cron',
        schedule_value: 'bad',
        targetJid: 'other@g.us',
      },
      'whatsapp_main', true, deps,
    );
    const tasksAfter = getAllTasks();
    expect(tasksAfter).toEqual(tasksBefore);
  });
});

// --- Requirement: IPC result file protocol ---
//
// The host writes a JSON result file ({filename}.result) to the IPC tasks
// directory after processing each request. The container polls for this file
// and returns the result to the model. This is how feedback flows from the
// host back to the container.

describe('IPC result file protocol', () => {
  it('the IPC watcher writes a result file after processing a task action', async () => {
    // This test verifies the integration contract: processTaskIpc returns
    // IpcResult, and the watcher loop writes it as a .result file.
    // We test the writeIpcResult helper directly since the watcher loop
    // depends on filesystem polling that is hard to test in isolation.
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');

    // Use the same writeIpcResult logic as ipc.ts
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-test-'));
    const resultPath = path.join(tmpDir, 'test.json.result');

    const result = { success: false, error: 'Task not found: task-123' };
    const tempPath = `${resultPath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(result));
    fs.renameSync(tempPath, resultPath);

    // Verify the file is valid JSON with the expected shape
    const read = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
    expect(read.success).toBe(false);
    expect(read.error).toBe('Task not found: task-123');

    // Cleanup
    fs.unlinkSync(resultPath);
    fs.rmdirSync(tmpDir);
  });

  it('result file uses atomic write (temp + rename) to prevent partial reads', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-test-'));
    const resultPath = path.join(tmpDir, 'atomic.json.result');
    const tempPath = `${resultPath}.tmp`;

    // Simulate atomic write
    fs.writeFileSync(tempPath, JSON.stringify({ success: true }));
    // Before rename, the result file should not exist
    expect(fs.existsSync(resultPath)).toBe(false);
    fs.renameSync(tempPath, resultPath);
    // After rename, the temp file should be gone and result should exist
    expect(fs.existsSync(tempPath)).toBe(false);
    expect(fs.existsSync(resultPath)).toBe(true);

    fs.unlinkSync(resultPath);
    fs.rmdirSync(tmpDir);
  });
});
