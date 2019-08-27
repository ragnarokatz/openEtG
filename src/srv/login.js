import crypto from 'crypto';
import util from 'util';
import * as sutil from './sutil.js';
import * as pg from './pg.js';
import * as Us from './Us.js';
import * as etg from '../etg.js';
import aiDecks from '../Decks.json';
import * as etgutil from '../etgutil.js';
import RngMock from '../RngMock.js';
import * as userutil from '../userutil.js';
const pbkdf2 = util.promisify(crypto.pbkdf2);

export default function login(sockEmit) {
	async function loginRespond(socket, user, pass, authkey) {
		sutil.initsalt(user);
		let key;
		if (authkey) {
			key = postHash(authkey);
		} else if (pass) {
			try {
				key = (await pbkdf2(
					pass,
					user.salt,
					user.iter,
					64,
					user.algo || 'SHA1',
				)).toString('base64');
			} catch (err) {
				sockEmit(socket, 'login', { err: err.message });
				return;
			}
		} else {
			key = '';
		}
		if (user.auth !== key) {
			if (user.auth) {
				sockEmit(socket, 'login', { err: 'Incorrect password' });
				return;
			} else {
				user.auth = key;
			}
		} else if (!authkey && !user.algo) {
			user.auth = user.salt = '';
			return loginRespond(socket, user, pass);
		}
		if (socket.readyState == 1) {
			const day = sutil.getDay();
			if (user.oracle < day) {
				if (user.ostreakday !== day - 1) {
					user.ostreak = 0;
				}
				user.ostreakday = 0;
				user.ostreakday2 = day;
				user.oracle = day;
				const ocardnymph = Math.random() < 0.03;
				const card = RngMock.randomcard(
					false,
					x => x.type != etg.Pillar && (x.rarity != 5) ^ ocardnymph,
				);
				const ccode = etgutil.asShiny(card.code, card.rarity == 5);
				if (card.rarity > 1) {
					user.accountbound = etgutil.addcard(user.accountbound, ccode);
				} else {
					user.pool = etgutil.addcard(user.pool, ccode);
				}
				user.ocard = ccode;
				user.daily = 0;
				user.dailymage = Math.floor(Math.random() * aiDecks.mage.length);
				user.dailydg = Math.floor(Math.random() * aiDecks.demigod.length);
			}
			Us.socks.set(user.name, socket);
			socket.send(
				JSON.stringify({
					...user,
					x: 'login',
					salt: undefined,
					iter: undefined,
					algo: undefined,
				}),
			);
			if (!user.daily) user.daily = 128;
			return pg.pool.query({
				text: `update users set wealth = $2 where name = $1`,
				values: [
					user.name,
					user.gold + Math.round(userutil.calcWealth(user.pool)),
				],
			});
		}
	}
	async function loginAuth(data) {
		const name = (data.u || '').trim();
		if (!name.length) {
			sockEmit(this, 'login', { err: 'No name' });
			return;
		} else {
			let user;
			try {
				user = await Us.load(name);
			} catch {
				user = { name, gold: 0 };
				Us.users.set(name, user);
			}
			return loginRespond(this, user, data.p, data.a);
		}
	}
	return loginAuth;
}
