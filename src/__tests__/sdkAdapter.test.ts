import { describe, it, expect } from 'vitest';
import { sdkMessageToEntries } from '../sdkAdapter';
import type { SDKAssistantMessage, SDKUserMessage, SDKResultMessage, SDKSystemMessage } from '@anthropic-ai/claude-agent-sdk';
import type { UUID } from 'crypto';

const SESSION_ID = '00ad78e2-a612-49a4-8533-8421f5e9306a' as UUID;
const MSG_UUID = '11ad78e2-a612-49a4-8533-8421f5e9306b' as UUID;

describe('sdkMessageToEntries', () => {
  describe('assistant messages', () => {
    it('converts text blocks', () => {
      const msg: SDKAssistantMessage = {
        type: 'assistant',
        message: {
          id: 'msg_01',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-6',
          content: [{ type: 'text', text: 'Hello from Claude' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        } as any,
        parent_tool_use_id: null,
        uuid: MSG_UUID,
        session_id: SESSION_ID,
      };

      const entries = sdkMessageToEntries(msg);
      expect(entries.length).toBeGreaterThanOrEqual(1);

      const textEntry = entries.find(e => e.entryType === 'text');
      expect(textEntry).toBeDefined();
      expect(textEntry!.content).toBe('Hello from Claude');
      expect(textEntry!.metadata?.role).toBe('assistant');
    });

    it('converts tool_use blocks', () => {
      const msg: SDKAssistantMessage = {
        type: 'assistant',
        message: {
          id: 'msg_01',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-6',
          content: [{
            type: 'tool_use',
            id: 'tool_01',
            name: 'Bash',
            input: { command: 'ls -la' },
          }],
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        } as any,
        parent_tool_use_id: null,
        uuid: MSG_UUID,
        session_id: SESSION_ID,
      };

      const entries = sdkMessageToEntries(msg);
      const toolEntry = entries.find(e => e.entryType === 'tool_use');
      expect(toolEntry).toBeDefined();
      expect(toolEntry!.content).toBe('Bash: ls -la');
      expect(toolEntry!.metadata?.tool_name).toBe('Bash');
      expect(toolEntry!.metadata?.tool_use_id).toBe('tool_01');
    });

    it('converts ExitPlanMode to plan approval', () => {
      const msg: SDKAssistantMessage = {
        type: 'assistant',
        message: {
          id: 'msg_01',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-6',
          content: [{
            type: 'tool_use',
            id: 'tool_plan',
            name: 'ExitPlanMode',
            input: { plan: '## Plan\n1. Fix the bug\n2. Add tests' },
          }],
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        } as any,
        parent_tool_use_id: null,
        uuid: MSG_UUID,
        session_id: SESSION_ID,
      };

      const entries = sdkMessageToEntries(msg);

      const planText = entries.find(e => e.metadata?.special === 'plan');
      expect(planText).toBeDefined();
      expect(planText!.content).toContain('Fix the bug');

      const planApproval = entries.find(e => e.metadata?.special === 'plan_approval');
      expect(planApproval).toBeDefined();
      expect(planApproval!.metadata?.has_plan).toBe(true);
    });

    it('sets has_plan=false for plan-less ExitPlanMode', () => {
      const msg: SDKAssistantMessage = {
        type: 'assistant',
        message: {
          id: 'msg_01',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-6',
          content: [{
            type: 'tool_use',
            id: 'tool_plan',
            name: 'ExitPlanMode',
            input: { plan: '' },
          }],
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        } as any,
        parent_tool_use_id: null,
        uuid: MSG_UUID,
        session_id: SESSION_ID,
      };

      const entries = sdkMessageToEntries(msg);

      // No plan text entry should be emitted
      const planText = entries.find(e => e.metadata?.special === 'plan');
      expect(planText).toBeUndefined();

      const planApproval = entries.find(e => e.metadata?.special === 'plan_approval');
      expect(planApproval).toBeDefined();
      expect(planApproval!.metadata?.has_plan).toBe(false);
    });

    it('converts AskUserQuestion to question entries', () => {
      const msg: SDKAssistantMessage = {
        type: 'assistant',
        message: {
          id: 'msg_01',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-6',
          content: [{
            type: 'tool_use',
            id: 'tool_q',
            name: 'AskUserQuestion',
            input: {
              questions: [
                { question: 'What should I do?', options: [{ label: 'Option A' }, { label: 'Option B' }] },
              ],
            },
          }],
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        } as any,
        parent_tool_use_id: null,
        uuid: MSG_UUID,
        session_id: SESSION_ID,
      };

      const entries = sdkMessageToEntries(msg);
      const questionEntry = entries.find(e => e.metadata?.special === 'ask_question');
      expect(questionEntry).toBeDefined();
      expect(questionEntry!.content).toBe('What should I do?');
      expect(questionEntry!.metadata?.options).toHaveLength(2);
    });

    it('includes token usage', () => {
      const msg: SDKAssistantMessage = {
        type: 'assistant',
        message: {
          id: 'msg_01',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-6',
          content: [{ type: 'text', text: 'Done' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 500, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        } as any,
        parent_tool_use_id: null,
        uuid: MSG_UUID,
        session_id: SESSION_ID,
      };

      const entries = sdkMessageToEntries(msg);
      const usageEntry = entries.find(e => e.metadata?.usage);
      expect(usageEntry).toBeDefined();
      expect(usageEntry!.content).toContain('500');
      expect(usageEntry!.content).toContain('200');
    });
  });

  describe('user messages', () => {
    it('converts string content', () => {
      const msg: SDKUserMessage = {
        type: 'user',
        message: { role: 'user', content: 'Fix the bug' },
        parent_tool_use_id: null,
      };

      const entries = sdkMessageToEntries(msg);
      expect(entries).toHaveLength(1);
      expect(entries[0].entryType).toBe('text');
      expect(entries[0].content).toBe('Fix the bug');
      expect(entries[0].metadata?.role).toBe('user');
    });

    it('converts array content with tool_result', () => {
      const msg: SDKUserMessage = {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tool_01', content: 'file1.ts\nfile2.ts' },
          ],
        },
        parent_tool_use_id: null,
      };

      const entries = sdkMessageToEntries(msg);
      const toolResult = entries.find(e => e.entryType === 'tool_result');
      expect(toolResult).toBeDefined();
      expect(toolResult!.content).toBe('file1.ts\nfile2.ts');
      expect(toolResult!.metadata?.tool_use_id).toBe('tool_01');
    });

    it('truncates long tool results', () => {
      const longContent = 'x'.repeat(3000);
      const msg: SDKUserMessage = {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tool_01', content: longContent },
          ],
        },
        parent_tool_use_id: null,
      };

      const entries = sdkMessageToEntries(msg);
      expect(entries[0].content.length).toBeLessThan(2100);
      expect(entries[0].content).toContain('...[truncated]');
    });
  });

  describe('result messages', () => {
    it('converts success result', () => {
      const msg = {
        type: 'result' as const,
        subtype: 'success' as const,
        duration_ms: 5000,
        duration_api_ms: 4000,
        is_error: false,
        num_turns: 3,
        result: 'Done',
        stop_reason: 'end_turn',
        total_cost_usd: 0.0123,
        usage: { input_tokens: 1000, output_tokens: 500 },
        modelUsage: {},
        permission_denials: [],
        uuid: MSG_UUID,
        session_id: SESSION_ID,
      } as unknown as SDKResultMessage;

      const entries = sdkMessageToEntries(msg);
      expect(entries).toHaveLength(1);
      expect(entries[0].entryType).toBe('system');
      expect(entries[0].content).toContain('3 turns');
      expect(entries[0].content).toContain('$0.0123');
    });

    it('converts error result', () => {
      const msg = {
        type: 'result' as const,
        subtype: 'error_during_execution' as const,
        duration_ms: 1000,
        duration_api_ms: 800,
        is_error: true,
        num_turns: 1,
        stop_reason: null,
        total_cost_usd: 0.001,
        usage: { input_tokens: 100, output_tokens: 10 },
        modelUsage: {},
        permission_denials: [],
        errors: ['Something went wrong'],
        uuid: MSG_UUID,
        session_id: SESSION_ID,
      } as unknown as SDKResultMessage;

      const entries = sdkMessageToEntries(msg);
      expect(entries).toHaveLength(1);
      expect(entries[0].entryType).toBe('error');
      expect(entries[0].content).toContain('Something went wrong');
    });
  });

  describe('system messages', () => {
    it('converts init message', () => {
      const msg = {
        type: 'system' as const,
        subtype: 'init' as const,
        claude_code_version: '1.2.3',
        model: 'claude-opus-4-6',
        tools: ['Bash', 'Read', 'Edit'],
        mcp_servers: [],
        permissionMode: 'plan' as const,
        apiKeySource: 'oauth' as const,
        cwd: '/workspace',
        slash_commands: [],
        output_style: 'default',
        skills: [],
        plugins: [],
        uuid: MSG_UUID,
        session_id: SESSION_ID,
      } as SDKSystemMessage;

      const entries = sdkMessageToEntries(msg);
      expect(entries).toHaveLength(1);
      expect(entries[0].entryType).toBe('system');
      expect(entries[0].content).toContain('1.2.3');
      expect(entries[0].metadata?.model).toBe('claude-opus-4-6');
    });
  });

  describe('ignored message types', () => {
    it('returns empty for stream_event messages', () => {
      const msg = { type: 'stream_event' as const, event: {}, parent_tool_use_id: null, uuid: MSG_UUID, session_id: SESSION_ID };
      expect(sdkMessageToEntries(msg as any)).toEqual([]);
    });
  });

  describe('tool input formatting', () => {
    it('formats Read tool', () => {
      const msg: SDKAssistantMessage = {
        type: 'assistant',
        message: {
          id: 'msg_01', type: 'message', role: 'assistant', model: 'claude-opus-4-6',
          content: [{ type: 'tool_use', id: 'tool_01', name: 'Read', input: { file_path: '/src/main.ts' } }],
          stop_reason: 'tool_use', stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        } as any,
        parent_tool_use_id: null, uuid: MSG_UUID, session_id: SESSION_ID,
      };

      const entries = sdkMessageToEntries(msg);
      const toolEntry = entries.find(e => e.entryType === 'tool_use');
      expect(toolEntry!.content).toBe('Read: /src/main.ts');
    });

    it('formats Grep tool', () => {
      const msg: SDKAssistantMessage = {
        type: 'assistant',
        message: {
          id: 'msg_01', type: 'message', role: 'assistant', model: 'claude-opus-4-6',
          content: [{ type: 'tool_use', id: 'tool_01', name: 'Grep', input: { pattern: 'TODO' } }],
          stop_reason: 'tool_use', stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        } as any,
        parent_tool_use_id: null, uuid: MSG_UUID, session_id: SESSION_ID,
      };

      const entries = sdkMessageToEntries(msg);
      const toolEntry = entries.find(e => e.entryType === 'tool_use');
      expect(toolEntry!.content).toBe('Grep: TODO');
    });
  });
});
