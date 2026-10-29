import { describe, expect, it, vi } from 'vitest';

import { runTuiLogin, runTuiLogout } from '../../src/cli/auth-command.js';

describe('Shards Code auth commands', () => {
  it.each([true, false])('returns after dispatching browser logout (%s)', async (openBrowser) => {
    const writeError = vi.fn();
    const logoutUrl =
      'https://agent.minimax.cn/auth/logout?logout_redirect_uri=https%3A%2F%2Fagent.minimax.cn';
    const logout = vi.fn(async () => ({
      state: 'signed-out' as const,
      message: 'Signed out of MiniMax.',
      logoutUrl,
    }));
    const openExternalTarget = vi.fn(() => {
      expect(logout).toHaveBeenCalledOnce();
      expect(writeError).toHaveBeenCalledWith(expect.stringContaining(logoutUrl));
      return new Promise<void>(() => {});
    });

    await expect(
      runTuiLogout({
        createApplication: () => ({ login: vi.fn(), logout }),
        writeError,
        openBrowser,
        openExternalTarget,
      }),
    ).resolves.toBe('Signed out of MiniMax.');

    expect(logout).toHaveBeenCalledOnce();
    expect(writeError).toHaveBeenCalledWith(`Finish signing out in your browser:\n${logoutUrl}\n`);
    if (openBrowser) expect(openExternalTarget).toHaveBeenCalledWith(logoutUrl);
    else expect(openExternalTarget).not.toHaveBeenCalled();
  });

  it.each(['reject', 'throw'] as const)(
    'keeps logout successful when browser startup fails by %s',
    async (failure) => {
      const writeError = vi.fn();
      const logoutUrl =
        'https://agent.minimax.cn/auth/logout?logout_redirect_uri=https%3A%2F%2Fagent.minimax.cn';
      const logout = vi.fn(async () => ({
        state: 'signed-out' as const,
        message: 'Signed out of MiniMax.',
        logoutUrl,
      }));

      await expect(
        runTuiLogout({
          createApplication: () => ({ login: vi.fn(), logout }),
          writeError,
          openExternalTarget: () => {
            const error = new Error('no desktop session');
            if (failure === 'throw') throw error;
            return Promise.reject(error);
          },
        }),
      ).resolves.toBe('Signed out of MiniMax.');

      expect(writeError).toHaveBeenCalledWith(expect.stringContaining(logoutUrl));
      expect(writeError).toHaveBeenLastCalledWith(
        "Couldn't open the default browser. Open the sign-out URL above manually.\n",
      );
    },
  );

  it('creates the logout application for the explicitly selected region', async () => {
    const logout = vi.fn(async () => ({
      state: 'signed-out' as const,
      message: 'Signed out of MiniMax Global.',
    }));
    const createApplication = vi.fn(() => ({ login: vi.fn(), logout }));

    await runTuiLogout({ region: 'en', createApplication });

    expect(createApplication).toHaveBeenCalledWith('en');
    expect(logout).toHaveBeenCalledOnce();
  });

  it('prints Device Flow instructions without exposing the internal device_code', async () => {
    const stderr: string[] = [];
    const openedTargets: string[] = [];
    const login = vi.fn(async (onProgress) => {
      onProgress?.({
        state: 'device-authorization',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://account.example.test/device',
        verificationUriComplete:
          'https://account.example.test/device?user_code=ABCD-EFGH',
        expiresInSec: 300,
      });
      return { state: 'authenticated' as const, message: 'Signed in with MiniMax.' };
    });

    await runTuiLogin({
      region: 'en',
      createApplication: () => ({ login, logout: vi.fn() }),
      writeError: (value) => stderr.push(value),
      openExternalTarget: async (target) => {
        openedTargets.push(target);
      },
    });

    expect(stderr.join('')).toBe(
      'Open: https://account.example.test/device?user_code=ABCD-EFGH&client_surface=tui&download_source=mcode-internal\nCode: ABCD-EFGH\nWaiting for authorization…\n',
    );
    expect(openedTargets).toEqual([
      'https://account.example.test/device?user_code=ABCD-EFGH&client_surface=tui&download_source=mcode-internal',
    ]);
    expect(stderr.join('')).not.toContain('device-secret');
  });

  it('keeps mcode login usable without a desktop browser when explicitly disabled', async () => {
    const stderr: string[] = [];
    const openedTargets: string[] = [];
    const login = vi.fn(async (onProgress) => {
      onProgress?.({
        state: 'device-authorization',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://account.example.test/device',
        expiresInSec: 300,
      });
      return { state: 'authenticated' as const, message: 'Signed in with MiniMax.' };
    });

    await runTuiLogin({
      openBrowser: false,
      createApplication: () => ({ login, logout: vi.fn() }),
      writeError: (value) => stderr.push(value),
      openExternalTarget: async (target) => {
        openedTargets.push(target);
      },
    });

    expect(openedTargets).toEqual([]);
    expect(stderr.join('')).toContain(
      'Open: https://account.example.test/device?client_surface=tui&download_source=mcode-internal',
    );
  });

  it('continues Device Flow when opening the default browser fails', async () => {
    const stderr: string[] = [];
    const login = vi.fn(async (onProgress) => {
      onProgress?.({
        state: 'device-authorization',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://account.example.test/device',
        expiresInSec: 300,
      });
      return { state: 'authenticated' as const, message: 'Signed in with MiniMax.' };
    });

    await expect(
      runTuiLogin({
        createApplication: () => ({ login, logout: vi.fn() }),
        writeError: (value) => stderr.push(value),
        openExternalTarget: async () => {
          throw new Error('no desktop session');
        },
      }),
    ).resolves.toBe('Signed in with MiniMax.');
    await vi.waitFor(() =>
      expect(stderr.join('')).toContain(
        "Couldn't open the default browser. Open the authorization URL above manually.",
      ),
    );
  });
});
