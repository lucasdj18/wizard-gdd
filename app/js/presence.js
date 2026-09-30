/* ============================================================
   presence.js — avatar do usuário e dos colaboradores (fase 7)

   Só visual por enquanto. Canto superior direito:
     [colaboradores…] [usuário]
   Quando o login (F2) existir, basta chamar:
     Presence.setUser({ name, photo })
     Presence.setCollaborators([{ id, name, photo, color }, …])
   e o layout se ajusta sozinho (até 4 avatares, depois "+N").
   ============================================================ */

const PRESENCE_MAX = 4;

// Silhueta padrão (sem foto)
const DEFAULT_AVATAR = `<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="12" r="6" fill="currentColor"/><path d="M4 30c1.5-7 6.3-10 12-10s10.5 3 12 10" fill="currentColor"/></svg>`;

const Presence = {
  user: null,          // { name, photo } — null = não logado
  others: [],          // colaboradores no mesmo documento

  setUser(user) { this.user = user; this.render(); },
  setCollaborators(list) { this.others = Array.isArray(list) ? list : []; this.render(); },

  avatar(person, cls) {
    const name = person?.name || t('presence.guest');
    const el = document.createElement(cls === 'presence-me' ? 'button' : 'span');
    el.className = `presence-avatar ${cls}`;
    el.title = name;
    el.setAttribute('aria-label', name);
    if (person?.color) el.style.setProperty('--ring', person.color);
    if (person?.photo) {
      const img = document.createElement('img');
      img.src = person.photo;
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      el.appendChild(img);
    } else if (person?.name) {
      el.textContent = person.name.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
    } else {
      el.innerHTML = DEFAULT_AVATAR;
    }
    return el;
  },

  render() {
    const box = document.getElementById('presence');
    if (!box) return;
    box.innerHTML = '';
    box.setAttribute('aria-label', t('presence.label'));

    // Colaboradores (espaço reservado): até 4 avatares, depois "+N"
    const others = document.createElement('div');
    others.className = 'presence-others';
    this.others.slice(0, PRESENCE_MAX).forEach(p => others.appendChild(this.avatar(p, 'presence-other')));
    if (this.others.length > PRESENCE_MAX) {
      const more = document.createElement('span');
      more.className = 'presence-avatar presence-more';
      more.textContent = `+${this.others.length - PRESENCE_MAX}`;
      more.title = this.others.slice(PRESENCE_MAX).map(p => p.name).join(', ');
      others.appendChild(more);
    }

    const me = this.avatar(this.user, 'presence-me');
    me.addEventListener('click', e => {
      const r = e.currentTarget.getBoundingClientRect();
      showContextMenu(r.right - 220, r.bottom + 6, [
        { label: this.user ? this.user.name : t('presence.guest'), run: () => {} },
        { label: t('action.google'), run: () => toast(t('soon.title'), t('soon.login')) },
      ]);
    });

    box.append(others, me);
  },
};

window.addEventListener('langchange', () => Presence.render());
