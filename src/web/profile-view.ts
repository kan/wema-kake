// 自分の表示名とアイコンを設定する画面（/profile。issue #121）。ヘッダーの自分のアイコンから開く。
//
// アイコンの画像は、ブラウザで正方形に切り抜き（中央）、`ICON_SIZE` に縮めて、WebP にしてから上げる
// （WebP を書き出せないブラウザでは JPEG）。`MAX_ICON_BYTES` を超えたら、画質を下げて作り直す。
import { ICON_CONTENT_TYPES, ICON_SIZE, MAX_DISPLAY_NAME_LENGTH, MAX_ICON_BYTES, type OwnProfile } from '../shared/api';
import { defaultName, emailOfActor } from '../shared/note-info';
import { getProfile, removeIcon, setDisplayName, setNoteNotice, uploadIcon } from './api';
import { appLink, el, type FailureKey, failureMessage } from './dom';
import { lang, t } from './i18n';
import { onViewEnd, viewSignal } from './navigation';
import { avatar, onProfilesChange, profileOf, updateOwnProfile } from './profiles';
import { viewSession } from './session';
import { site } from './site';
import { header, langButton, toast } from './toolbar';

const NOTICE_MS = 8000;

/** 画質を下げていく順（toBlob の quality）。最後でも上限を超えたら、あきらめる */
const QUALITIES = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3];

export function openProfile(app: HTMLElement): void {
  document.title = t('documentTitle', t('profile.title'), site.siteName);
  const body = el('div', { className: 'profile-body' }, el('p', { textContent: t('loading') }));
  app.append(header([appLink('/', t('list')), el('h1', { textContent: t('profile.title') })], [], [langButton()]), body);

  const signal = viewSignal();
  const notify = toast(app, NOTICE_MS);
  Promise.all([viewSession(), getProfile()])
    .then(([{ actor }, profile]) => {
      if (signal.aborted) return;
      updateOwnProfile(actor, { name: profile.name, icon: profile.icon });
      body.replaceChildren(profileForm(actor, notify, profile));
    })
    .catch((e) => {
      if (!signal.aborted) body.replaceChildren(el('p', { textContent: failureMessage('failed.profile', e) }));
    });
}

/** `run` の間は `button` を押せなくし、失敗したら `failKey` の文言で知らせる */
function busy<T>(
  button: HTMLButtonElement | HTMLInputElement,
  run: () => Promise<T>,
  notify: (text: string) => void,
  failKey: FailureKey,
) {
  button.disabled = true;
  run()
    .catch((err) => notify(failureMessage(failKey, err)))
    .finally(() => {
      button.disabled = false;
    });
}

/**
 * 自分が作ったページに、ほかの人が付箋を足したらメールで知らせるか（issue #131）。サイトがメールを
 * 送れなければ出さない。メールの言語は、切り替えたときの画面の言語にする
 */
function noteNoticeField(profile: OwnProfile, notify: (text: string) => void): HTMLElement | null {
  if (!profile.mail) return null;
  const checkbox = el('input', { type: 'checkbox', checked: profile.notifyNotes });
  checkbox.addEventListener('change', () => {
    const on = checkbox.checked;
    busy(
      checkbox,
      async () => {
        try {
          await setNoteNotice(on, lang);
        } catch (err) {
          checkbox.checked = !on;
          throw err;
        }
        notify(t('profile.saved'));
      },
      notify,
      'failed.notify',
    );
  });
  return el(
    'div',
    { className: 'profile-notify' },
    el('label', {}, checkbox, el('span', { textContent: t('profile.notifyNotes') })),
    el('p', { className: 'profile-hint', textContent: t('profile.notifyNotesHint') }),
  );
}

function profileForm(actor: string, notify: (text: string) => void, profile: OwnProfile): HTMLElement {
  const current = () => profileOf(actor) ?? { name: null, icon: null };
  const preview = el('span', { className: 'profile-avatar' });
  const remove = el('button', { type: 'button', className: 'text-button', textContent: t('profile.removeIcon') });
  const draw = () => {
    preview.replaceChildren(avatar(actor));
    remove.hidden = current().icon === null;
  };
  draw();
  onViewEnd(onProfilesChange(draw));

  // 表示名
  const nameInput = el('input', {
    type: 'text',
    // maxLength は UTF-16 の単位で数えるので、絵文字（サロゲートペア）でも上限まで打てる値にする。
    // 上限はサーバーが文字数（コードポイント）で確かめる
    maxLength: MAX_DISPLAY_NAME_LENGTH * 2,
    value: current().name ?? '',
    placeholder: defaultName(actor),
  });
  const saveName = el('button', { type: 'submit', className: 'text-button', textContent: t('profile.save') });
  const nameForm = el(
    'form',
    { className: 'profile-name' },
    el('label', {}, el('span', { textContent: t('profile.name') }), nameInput),
    saveName,
    el('p', { className: 'profile-hint', textContent: t('profile.nameHint', MAX_DISPLAY_NAME_LENGTH) }),
  );
  nameForm.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(
      saveName,
      async () => {
        const { name } = await setDisplayName(nameInput.value);
        updateOwnProfile(actor, { ...current(), name });
        nameInput.value = name ?? '';
        notify(t('profile.saved'));
      },
      notify,
      'failed.profile',
    );
  });

  // アイコン
  const fileInput = el('input', { type: 'file', accept: 'image/*', hidden: true });
  const choose = el('button', { type: 'button', className: 'text-button', textContent: t('profile.chooseIcon') });
  choose.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    busy(
      choose,
      async () => {
        const icon = await uploadIcon(await makeIcon(file));
        updateOwnProfile(actor, { ...current(), icon });
        notify(t('profile.saved'));
      },
      notify,
      'failed.icon',
    );
  });
  remove.addEventListener('click', () =>
    busy(
      remove,
      async () => {
        await removeIcon();
        updateOwnProfile(actor, { ...current(), icon: null });
      },
      notify,
      'failed.icon',
    ),
  );

  return el(
    'div',
    { className: 'profile-form' },
    el(
      'div',
      { className: 'profile-icon' },
      preview,
      el('div', { className: 'profile-icon-actions' }, choose, remove, fileInput),
      el('p', { className: 'profile-hint', textContent: t('profile.iconHint') }),
    ),
    nameForm,
    noteNoticeField(profile, notify),
    // ほかの人には、名前とアイコンの説明（ツールチップ）に、この email も出る
    el('p', { className: 'profile-hint', textContent: t('profile.account', emailOfActor(actor) ?? actor) }),
  );
}

/**
 * 画像を中央で正方形に切り抜き、`ICON_SIZE` の WebP（書き出せなければ JPEG）にする。上限を超えたら、
 * 画質を下げて作り直す
 */
async function makeIcon(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error(t('profile.notImage'));
  });
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = el('canvas', { width: ICON_SIZE, height: ICON_SIZE });
  const context = canvas.getContext('2d');
  if (!context) throw new Error(t('profile.notImage'));
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, ICON_SIZE, ICON_SIZE);
  bitmap.close();
  for (const type of ICON_CONTENT_TYPES) {
    for (const quality of QUALITIES) {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
      // 書き出せない形式（Safari の WebP）は、PNG で返ってくる。次の形式を試す
      if (!blob || blob.type !== type) break;
      if (blob.size <= MAX_ICON_BYTES) return blob;
    }
  }
  throw new Error(t('profile.tooLarge'));
}
