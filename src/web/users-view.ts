// 利用者の承認（設定の `approval`。issue #120）の画面。
//
// - 利用者の画面（/users）: 管理者だけが使える。来た人の一覧を出し、承認と拒否をする
// - 承認待ちの表示: 承認が済んでいない人には、どのパスでも、これだけを出す（Worker が index.html に
//   状態を埋め込む。src/web/site.ts の `unapproved`）
import type { UserEntry } from '../shared/api';
import { ApiError, decideUser, listUsers } from './api';
import { appLink, el, failureMessage, formatDate } from './dom';
import { t } from './i18n';
import { viewSignal } from './navigation';
import { userActor } from '../shared/note-info';
import { avatar, displayName, profileOf, requestProfiles } from './profiles';
import { site } from './site';
import { header, langButton, toast, trashLink } from './toolbar';

const NOTICE_MS = 8000;

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', { type: 'button', className: 'text-button', textContent: label });
  b.addEventListener('click', onClick);
  return b;
}

export function openUsers(app: HTMLElement): void {
  document.title = t('documentTitle', t('users.title'), site.siteName);
  const body = el('div', { className: 'users-body' }, el('p', { textContent: t('loading') }));
  app.append(
    header([appLink('/', t('list')), el('h1', { textContent: t('users.title') })], [], [trashLink(), langButton()]),
    body,
  );

  const signal = viewSignal();
  const notify = toast(app, NOTICE_MS);
  const load = (): Promise<void> =>
    listUsers()
      .then(async (users) => {
        // 一覧の人と、承認か拒否をした管理者の表示名を、描く前に引く
        await requestProfiles(users.flatMap((user) => [userActor(user.email), ...(user.decided_by ? [user.decided_by] : [])]));
        if (!signal.aborted) body.replaceChildren(usersTable(users, load, notify));
      })
      .catch((e) => {
        if (signal.aborted) return;
        // 管理者でない人は 403、承認が無効なら 404
        const status = e instanceof ApiError ? e.status : undefined;
        const message = status === 403 ? t('users.forbidden') : status === 404 ? t('notFound') : failureMessage('failed.users', e);
        body.replaceChildren(el('p', { textContent: message }));
      });
  void load();
}

function usersTable(users: UserEntry[], reload: () => Promise<void>, notify: (text: string) => void): HTMLElement {
  if (users.length === 0) return el('p', { textContent: t('users.empty') });
  const decide = (user: UserEntry, status: 'approved' | 'rejected') => {
    // 使っている人を締め出すときだけ確かめる
    if (status === 'rejected' && user.status === 'approved' && !confirm(t('users.rejectConfirm', user.email))) return;
    decideUser(user.email, status)
      .then(reload)
      .catch((e) => notify(failureMessage('failed.decide', e)));
  };
  return el(
    'table',
    { className: 'users-table' },
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        el('th', { textContent: t('users.email') }),
        el('th', { textContent: t('users.status') }),
        el('th', { textContent: t('users.createdAt') }),
        el('th', { textContent: t('users.decidedBy') }),
        el('th', {}),
      ),
    ),
    el(
      'tbody',
      {},
      ...users.map((user) =>
        el(
          'tr',
          {},
          // 表示名とアイコン（issue #121）も並べる。承認するかを、名前で見分けられるように
          el(
            'td',
            { className: 'user-email' },
            avatar(userActor(user.email)),
            el('span', { textContent: user.email }),
            el('span', { className: 'user-name', textContent: profileOf(userActor(user.email))?.name ?? '' }),
          ),
          el(
            'td',
            {},
            user.admin
              ? el('span', { className: 'user-status user-status-admin', textContent: t('users.admin') })
              : el('span', { className: `user-status user-status-${user.status}`, textContent: t(`users.status.${user.status}`) }),
          ),
          el('td', { textContent: user.created_at === null ? '' : formatDate(user.created_at) }),
          el('td', {
            className: 'user-decided',
            textContent:
              user.decided_by !== null && user.decided_at !== null ? t('users.decided', displayName(user.decided_by), formatDate(user.decided_at)) : '',
          }),
          el(
            'td',
            { className: 'user-actions' },
            // 管理者は、いつも承認済み（設定の `admins` で決まる）
            ...(user.admin || user.status === 'approved' ? [] : [button(t('users.approve'), () => decide(user, 'approved'))]),
            ...(user.admin || user.status === 'rejected' ? [] : [button(t('users.reject'), () => decide(user, 'rejected'))]),
          ),
        ),
      ),
    ),
  );
}

/** 承認が済んでいない人に出す表示。ほかの画面は出さない（API も WebSocket も 403 になる） */
export function openApprovalWait(app: HTMLElement, status: 'pending' | 'rejected'): void {
  document.title = t('documentTitle', t(`approval.${status}.title`), site.siteName);
  const reload = button(t('approval.reload'), () => location.reload());
  app.append(
    header([el('h1', { textContent: site.siteName })], [], [langButton()]),
    el(
      'div',
      { className: 'approval-body' },
      el('h2', { textContent: t(`approval.${status}.title`) }),
      el('p', { textContent: t(`approval.${status}.body`) }),
      ...(status === 'pending' ? [reload] : []),
    ),
  );
}
