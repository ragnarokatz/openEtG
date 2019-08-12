#!/usr/bin/node
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
process.chdir(__dirname);

import fsCb from 'fs';
const fs = fsCb.promises;

import crypto from 'crypto';
import http from 'http';
import https from 'https';
import qs from 'querystring';
import ws from 'ws';
import * as etg from './src/etg.js';
import Cards from './src/Cards.js';
import RngMock from './src/RngMock.js';
import * as etgutil from './src/etgutil.js';
import * as usercmd from './src/usercmd.js';
import * as userutil from './src/userutil.js';
import * as sutil from './src/srv/sutil.js';
import db from './src/srv/db.js';
import * as Us from './src/srv/Us.js';
import * as Bz from './src/srv/Bz.js';
import starter from './src/srv/starter.json';
import forkcore from './src/srv/forkcore.js';
import login from './src/srv/login.js';
import Lock from './src/srv/Lock.js';
import config from './config.json';

const MAX_INT = 0x100000000;
const sockmeta = new WeakMap();
const importlocks = new Map();
(async () => {
	const [keypem, certpem] = config.certs
		? await Promise.all([
				fs.readFile(`${config.certs}/oetg-key.pem`),
				fs.readFile(`${config.certs}/oetg-cert.pem`),
		  ])
		: [];
	function activeUsers() {
		const activeusers = [];
		for (let [name, sock] of Us.socks) {
			if (sock.readyState === 1) {
				const meta = sockmeta.get(sock);
				if (meta.offline) continue;
				if (meta.afk) name += ' (afk)';
				else if (meta.wantpvp) name += '\xb6';
				activeusers.push(name);
			}
		}
		return activeusers;
	}
	function genericChat(_socket, data) {
		data.x = 'chat';
		broadcast(data);
	}
	function broadcast(data) {
		const msg = JSON.stringify(data);
		for (const sock of wss.clients) {
			if (sock.readyState === 1) sock.send(msg);
		}
	}
	function getAgedHp(hp, age) {
		return Math.max(hp - age * age, Math.ceil(hp / 2));
	}
	function wilson(up, total) {
		// from npm's wilson-score
		const z = 2.326348,
			z2 = z * z,
			phat = up / total;
		return (
			(phat +
				z2 / (2 * total) -
				z * Math.sqrt((phat * (1 - phat) + z2 / (4 * total)) / total)) /
			(1 + z2 / total)
		);
	}
	function sockEmit(socket, event, data) {
		if (socket.readyState === 1) {
			if (!data) data = {};
			data.x = event;
			socket.send(JSON.stringify(data));
		}
	}
	function roleck(key, func) {
		return async function(data, user, meta, userid) {
			const ismem = await pg.pool.query({
				text: `select exists(select * from user_role ur join roles r on ur.role_id = r.id where ur.user_id = $1 and r.val = $2) res`,
				values: [userid, key],
			});
			if (ismem.rows[0].res) {
				return func.call(this, data, user, meta);
			} else {
				sockEmit(this, 'chat', {
					mode: 1,
					msg: `You aren't a member of ${key}`,
				});
			}
		};
	}
	function addRoleHandler(role) {
		return roleck(role, function addRole(data, user) {
			return pg.pool.query({
				text: `insert into user_role (user_id, role_id) select u.id, r.id from users u, roles r where u.name = $1 and r.val = $2 on conflict do nothing`,
				values: [data.m, role],
			});
		});
	}
	function rmRoleHandler(role) {
		return roleck(role, function rmRole(data, user) {
			return pg.pool.query({
				text: `delete from user_role ur using users u, roles r where ur.user_id = u.id and ur.role_id = r.id and u.name = $1 and r.val = $2`,
				values: [data.m, role],
			});
		});
	}
	function listRoleHandler(role) {
		return async function listRole(data) {
			const ms = await pg.pool.query({
				text: `select u.name from user_role ur join users u on u.id = ur.user_id join roles r on r.id = ur.role_id where r.val = $1 order by u.name`,
				values: [role],
			});
			sockEmit(this, 'chat', {
				mode: 1,
				msg: ms.rows.map(x => x.name).join(),
			});
		};
	}
	const userEvents = {
		modadd: addRoleHandler('Mod'),
		modrm: rmRoleHandler('Mod'),
		codesmithadd: addRoleHandler('Codesmith'),
		codesmithrm: rmRoleHandler('Codesmith'),
		modguest: roleck('Mod', function(data, user) {
			return db.set('GuestsBanned', data.m === 'off' ? '1' : '');
		}),
		modmute: roleck('Mod', function(data, user) {
			broadcast({ x: 'mute', m: data.m });
		}),
		modclear: roleck('Mod', function(data, user) {
			broadcast({ x: 'clear' });
		}),
		modmotd: roleck('Mod', function(data, user) {
			const match = data.m.match(/^(\d+) ?(.*)$/);
			if (match) {
				const num = match[1],
					text = match[2];
				if (text) {
					return pg.pool.query({
						text: `insert into motd (id, val) values ($1, $2) on conflict update set val = $2`,
						values: [num, text],
					});
				} else {
					return pg.pool.query({
						text: `delete from motd where id = $1`,
						values: [num],
					});
				}
			} else {
				sockEmit(this, 'chat', { mode: 1, msg: 'Invalid format' });
			}
		}),
		inituser(data, user) {
			if (data.e < 1 || data.e > 13) return;
			const sid = (data.e - 1) * 6;
			user.pvpwins = user.pvplosses = user.aiwins = user.ailosses = 0;
			user.accountbound = starter[sid];
			user.oracle = 0;
			user.pool = '';
			user.freepacks = [starter[sid + 4], starter[sid + 5], 1];
			user.selectedDeck = '1';
			user.qecks = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
			user.decks = {
				1: starter[sid + 1],
				2: starter[sid + 2],
				3: starter[sid + 3],
			};
			user.quests = {};
			user.streak = [];
			sockEvents.login.call(this, { u: user.name, a: user.auth });
		},
		async logout({ u }, user, meta, userId) {
			await pg.pool.query({
				text: `update users set data = $2 where id = $1`,
				values: [userId, JSON.stringify(user)],
			});
			Us.users.delete(u);
			Us.socks.delete(u);
		},
		async delete({ u }, user, meta, userId) {
			await pg.pool.query({
				text: `delete from users where id = $1`,
				values: [userId],
			});
			Us.users.delete(u);
			Us.socks.delete(u);
		},
		async setarena(data, user, meta, userId) {
			if (!user.ocard || !data.d) {
				return;
			}
			const au = `${data.lv ? 'B:' : 'A:'}${data.u}`;
			if (data.mod) {
				return pg.pool.query({
					text: `update arena set deck = $3, hp = $4, draw = $5, mark = $6 where user_id = $1 and arena_id = $2`,
					values: [
						userId,
						data.lv ? 2 : 1,
						data.d,
						data.hp,
						data.draw,
						data.mark,
					],
				});
			} else {
				const res = await pg.pool.query({
					text: `select day from arena where user_id = $1 and arena_id = $2`,
					values: [userId, data.lv ? 2 : 1],
				});
				const today = sutil.getDay();
				if (res.rowCount) {
					const age = today - res.rows[0].day;
					if (age > 0) {
						user.gold += Math.min(age * 25, 350);
					}
				}
				return await pg.pool.query({
					text: `insert into arena (user_id, arena_id, day, deck, card, won, loss, hp, draw, mark, score) values ($1, $2, $3, $4, $5, 0, 0, $6, $7, $8, 250)
on conflict (user_id, arena_id) do update set day = $3, deck = $4, card = $5, won = 0, loss = 0, hp = $6, draw = $7, mark = $8, score = 250`,
					values: [
						userId,
						data.lv ? 2 : 1,
						today,
						data.d,
						user.ocard,
						data.hp,
						data.draw,
						data.mark,
					],
				});
			}
		},
		async arenainfo(data, user, meta, userId) {
			const day = sutil.getDay();
			const res = await pg.pool.query({
				text: `select arena_id, ($2 - day) day, draw, mark, hp, won, loss, code, "rank" from (
select *, rank(score) over (partition by arena_id order by score) "rank" from arena
) arena where user_id = $1`,
				values: [userId, day],
			});
			const info = {};
			for (const row of res.rows) {
				info[res.arena_id === 1 ? 'A' : 'B'] = {
					rank: row.rank,
					hp: row.hp,
					curhp: getAgedHp(row.hp, row.day),
					mark: row.mark,
					draw: row.draw,
					win: row.won,
					loss: row.loss,
					card: row.code,
				};
			}
			sockEmit(this, 'arenainfo', info);
		},
		async modarena(data, user) {
			Us.load(data.aname)
				.then(user => (user.gold += data.won ? 15 : 5))
				.catch(() => {});
<<<<<<< HEAD
			const arena = `arena${data.lv ? '1' : ''}`,
				akey = (data.lv ? 'B:' : 'A:') + data.aname;
			const score = await db.zscore(arena, data.aname);
			if (score === null) return;
			const [incr, mget] = await Promise.all([
				db.hincrby(akey, data.won ? 'win' : 'loss', 1),
				db.hmget(akey, data.won ? 'loss' : 'win', 'day'),
			]);
			const won = +(data.won ? incr : mget[0]),
				loss = +(data.won ? mget[0] : incr),
				day = +mget[1];
			return db.zadd(
				arena,
				wilson(won + 1, won + loss + 1) * 1000 - (sutil.getDay() - day) * 2,
				data.aname,
			);
=======
			const arenaId = data.lv ? 2 : 1;
			const res = await pg.pool.query({
				text: `select a.user_id, a.won, a.loss, ($3 - a.day) day from arena a join users u on a.user_id = u.id and a.arena_id = $1 where u.name = $2`,
				values: [arenaId, data.aname, sutil.getDay()],
			});
			if (res.rows.length === 0) return;
			const row = res.rows[0],
				won = row.won + (data.won ? 1 : 0),
				loss = row.loss + (data.won ? 0 : 1),
				wlfield = data.won ? 'won' : 'loss';
			return pg.pool.query({
				text: `update arena set ${wlfield} = ${wlfield} + 1, score = $3 where user_id = $1 and arena_id = $2`,
				values: [
					row.user_id,
					arenaId,
					((wilson(won + 1, won + loss + 1) * 1000) | 0) - row.day,
				],
			});
>>>>>>> Initial draft of replacing redis with postgres in server.js. Still not ported: ImportOriginal, GuestBanned, kongapi
		},
		async foearena(data, user) {
			const arenaId = data.lv ? 2 : 1;
			const reslen = await pg.pool.query({
					text: `select count(*) len from arena where arena_id = $1`,
					values: [arenaId],
				}),
				{ len } = reslen.rows[0];
			if (!len) return;
			const idx = RngMock.upto(Math.min(len, 20));
			const ares = await pg.pool.query({
					query: `select u.name, a.* from arena a join users u on u.id = a.user_id having rank(score) over (partition by arena_id order by score) = $2 where arena_id = $1`,
					values: [arenaId, idx],
				}),
				adeck = ares.rows[0];
			const age = sutil.getDay() - adeck.day;
			const curhp = getAgedHp(adeck.hp, age);
			sockEmit(this, 'foearena', {
				seed: (Math.random() * MAX_INT) | 0,
				name: adeck.name,
				hp: curhp,
				age: age,
				rank: idx,
				mark: adeck.mark,
				draw: adeck.draw,
				deck: `${adeck.deck}05${(data.lv
					? etgutil.asUpped(adeck.card, true)
					: adeck.code
				).toString(32)}`,
				lv: data.lv,
			});
		},
		setgold: roleck('Codesmith', async function(data, user) {
			const tgt = await Us.load(data.t);
			sockEmit(this, 'chat', {
				mode: 1,
				msg: `Set ${tgt.name} from ${tgt.gold}$ to ${data.g}$`,
			});
			tgt.gold = data.g;
		}),
		codecreate: roleck('Codesmith', async function(data, user) {
			if (!data.t) {
				return sockEmit(this, 'chat', {
					mode: 1,
					msg: `Invalid type ${data.t}`,
				});
			}
			let code = '';
			for (let i = 0; i < 8; i++) {
				code += string.fromCharCode(33 + ((Math.random() * 93) | 0));
			}
			try {
				await pg.pool.query({
					text: `insert into codes values ($1, $2)`,
					values: [code, data.t],
				});
			} catch {
				return sockEmit(this, 'chat', {
					mode: 1,
					msg: `Failed to create code`,
				});
			}
			sockEmit(this, 'chat', { mode: 1, msg: `${data.t} ${code}` });
		}),
		codesubmit(data, user) {
			return pg.pool.trx(async sql => {
				const obj = await sql.query({
						text: `select val from codes where code = $1`,
						values: [data.code],
					}),
					type = obj.rows[0].val;
				if (!type) {
					sockEmit(this, 'chat', {
						mode: 1,
						msg: 'Code does not exist',
					});
				} else if (type.charAt(0) === 'G') {
					const g = +type.slice(1);
					if (isNaN(g)) {
						sockEmit(this, 'chat', {
							mode: 1,
							msg: `Invalid gold code type: ${type}`,
						});
					} else {
						user.gold += g;
						sockEmit(this, 'codegold', { g });
						return sql.query({
							text: `delete from codes where code = $1`,
							values: [data.code],
						});
					}
				} else if (type.charAt(0) === 'C') {
					const c = parseInt(type.slice(1), 32);
					if (c in Cards.Codes) {
						user.pool = etgutil.addcard(user.pool, c);
						sockEmit(this, 'codecode', { card: c });
						return sql.query({
							text: `delete from codes where code = $1`,
							values: [data.code],
						});
					} else {
						sockEmit(this, 'chat', {
							mode: 1,
							msg: `Unknown card: ${type}`,
						});
					}
				} else if (type.replace(/^!?(upped)?/, '') in userutil.rewardwords) {
					sockEmit(this, 'codecard', { type });
				} else {
					sockEmit(this, 'chat', {
						mode: 1,
						msg: `Unknown code type: ${type}`,
					});
				}
			});
		},
		async codesubmit2(data, user) {
			const obj = await sql.query({
					text: `select val from codes where code = $1`,
					values: [data.code],
				}),
				type = obj.rows[0].val;
			if (!type) {
				sockEmit(this, 'chat', { mode: 1, msg: 'Code does not exist' });
			} else if (type.replace(/^!/, '') in userutil.rewardwords) {
				const card = Cards.Codes[data.card];
				if (
					card &&
					card.rarity === userutil.rewardwords[type.replace(/^!/, '')] &&
					card.shiny ^ (type.charAt(0) !== '!')
				) {
					user.pool = etgutil.addcard(user.pool, data.card);
					sockEmit(this, 'codedone', { card: data.card });
					return sql.query({
						text: `delete from codes where code = $1`,
						values: [data.code],
					});
				}
			} else {
				sockEmit(this, 'chat', {
					mode: 1,
					msg: 'Unknown code type: ' + type,
				});
			}
		},
		foewant(data, user, thismeta) {
			const { u, f } = data;
			if (u === f) return;
			console.log(`${u} requesting ${f}`);
			const deck = user.decks[user.selectedDeck];
			if (!deck) return;
			thismeta.deck = deck;
			const foesock = Us.socks.get(f);
			if (foesock && foesock.readyState === 1) {
				const foemeta = sockmeta.get(foesock);
				if (foemeta.duel === u) {
					thismeta.duel = f;
					const data = {
						seed: (Math.random() * MAX_INT) | 0,
						players: RngMock.shuffle([
							{
								idx: 1,
								deck: thismeta.deck,
								name: u,
								user: u,
								markpower: 1,
							},
							{
								idx: 2,
								deck: foemeta.deck,
								name: f,
								user: f,
								markpower: 1,
							},
						]),
					};
					sockEmit(this, 'pvpgive', { data });
					sockEmit(foesock, 'pvpgive', { data });
				} else {
					thismeta.duel = f;
					sockEmit(foesock, 'challenge', { f: u, pvp: true });
				}
			}
		},
		spectate(data, user) {
			const tgt = Us.socks.get(data.f),
				tgtmeta = sockmeta.get(tgt);
			if (tgt && tgtmeta.duel) {
				sockEmit(tgt, 'chat', {
					mode: 1,
					msg: `${data.u} is spectating.`,
				});
				if (!tgtmeta.spectators) tgtmeta.spectators = [];
				tgtmeta.spectators.push(data.u);
			}
		},
		canceltrade(data, user, info) {
			if (info.trade) {
				const foesock = Us.socks.get(info.trade.foe),
					foemeta = sockmeta.get(foesock);
				if (foesock) {
					sockEmit(foesock, 'tradecanceled');
					sockEmit(foesock, 'chat', {
						mode: 1,
						msg: `${data.u} has canceled the trade.`,
					});
					if (foemeta.trade && foemeta.trade.foe === data.u)
						delete foemeta.trade;
				}
				delete info.trade;
			}
		},
		confirmtrade(data, user, thismeta) {
			const thistrade = thismeta.trade;
			if (!thistrade) {
				return;
			}
			thistrade.tradecards = data.cards;
			thistrade.g = Math.abs(data.g | 0);
			thistrade.oppcards = data.oppcards;
			thistrade.gopher = Math.abs(data.gopher | 0);
			const thatsock = Us.socks.get(thistrade.foe),
				thatmeta = thatsock && sockmeta.get(thatsock);
			const thattrade = thatmeta && thatmeta.trade;
			const otherUser = Us.users.get(thistrade.foe);
			if (!thattrade || !otherUser) {
				sockEmit(this, 'tradecanceled');
				delete thismeta.trade;
				return;
			} else if (thattrade.accepted) {
				const player1Cards = thistrade.tradecards,
					player2Cards = thattrade.tradecards,
					player1Gold = thistrade.g,
					player2Gold = thattrade.g,
					p1gdelta = (player2Gold - player1Gold) | 0,
					p2gdelta = (player1Gold - player2Gold) | 0;
				if (
					player1Cards !== thattrade.oppcards ||
					player2Cards !== thistrade.oppcards ||
					player1Gold !== thattrade.gopher ||
					player2Gold !== thistrade.gopher ||
					user.gold + p1gdelta < 0 ||
					otherUser.gold + p2gdelta < 0
				) {
					sockEmit(this, 'tradecanceled');
					sockEmit(this, 'chat', {
						mode: 1,
						msg: 'Trade disagreement.',
					});
					sockEmit(thatsock, 'tradecanceled');
					sockEmit(thatsock, 'chat', {
						mode: 1,
						msg: 'Trade disagreement.',
					});
					return;
				}
				sockEmit(this, 'tradedone', {
					oldcards: player1Cards,
					newcards: player2Cards,
					g: p1gdelta,
				});
				sockEmit(thatsock, 'tradedone', {
					oldcards: player2Cards,
					newcards: player1Cards,
					g: p2gdelta,
				});
				user.pool = etgutil.removedecks(user.pool, player1Cards);
				user.pool = etgutil.mergedecks(user.pool, player2Cards);
				user.gold += p1gdelta;
				otherUser.pool = etgutil.removedecks(otherUser.pool, player2Cards);
				otherUser.pool = etgutil.mergedecks(otherUser.pool, player1Cards);
				otherUser.gold += p2gdelta;
				delete thismeta.trade;
				delete thatmeta.trade;
			} else {
				thistrade.accepted = true;
			}
		},
		tradewant(data, user, thismeta) {
			const { u, f } = data;
			if (u === f) {
				return;
			}
			console.log(`${u} requesting ${f}`);
			const foesock = Us.socks.get(f);
			if (foesock && foesock.readyState === 1) {
				thismeta.trade = { foe: f };
				const foetrade = sockmeta.get(foesock).trade;
				if (foetrade && foetrade.foe === u) {
					sockEmit(this, 'tradegive');
					sockEmit(foesock, 'tradegive');
				} else {
					sockEmit(foesock, 'challenge', { f: u });
				}
			}
		},
		importoriginal(data, user) {
			if (user.origName && user.origName !== data.name) {
				sockEmit(this, 'chat', {
					msg: `Your account is already bound to ${user.origName}`,
					mode: 1,
				});
				return;
			}
			const reqdata = `user=${encodeURIComponent(
				data.name,
			)}&psw=${encodeURIComponent(data.pass)}&errorcode=%2D1`;
			const req = http
				.request(
					'http://www.elementsthegame.com/testo5.php',
					{
						method: 'POST',
						headers: {
							'Content-Type': 'application/x-www-form-urlencoded',
							'Content-Length': reqdata.length,
							Origin: 'http://elementsthegame.com',
							Referrer: 'http://elementsthegame.com/elt1327.swf',
						},
					},
					res => {
						const chunks = [];
						res.on('error', e => console.error(e.message));
						res.on('data', chunk => chunks.push(chunk));
						res.on('end', () => {
							const opts = qs.parse(Buffer.concat(chunks).toString());
							if (!opts || !opts.decka) {
								sockEmit(this, 'chat', {
									msg: `Failed to load cardpool. Error code: ${opts &&
										opts.error}`,
									mode: 1,
								});
								return;
							}
							const { decka } = opts;
							let tobound = '',
								topool = '';
							for (let i = 1; i < decka.length; i += 7) {
								const code = parseInt(decka.substring(i, i + 4), 10) + 5000,
									count = parseInt(decka.substring(i + 4, i + 7), 10),
									card = Cards.Codes[code];
								if (card) {
									if (~etg.NymphList.indexOf(etgutil.asUpped(code, false))) {
										tobound +=
											etgutil.encodeCount(count) +
											etgutil.encodeCode(etgutil.asShiny(code, true));
									}
									if (card.rarity === -1) {
										topool +=
											etgutil.encodeCount(count) + etgutil.encodeCode(code);
									}
								}
							}
							let lock = importlocks.get(data.name);
							if (!lock) {
								lock = new Lock();
								importlocks.set(data.name, lock);
							}
							lock
								.exec(async () => {
									const oldimport = await db.hget('ImportOriginal', data.name),
										impdata = sutil.parseJSON(oldimport) || {};
									let newbound, newpool;
									if (impdata.name && impdata.name !== user.name) {
										sockEmit(this, 'chat', {
											msg: `${data.name} is bound to ${impdata.name}`,
											mode: 1,
										});
										return;
									} else {
										newbound = etgutil.removedecks(
											tobound,
											impdata.bound || '',
										);
										newpool = etgutil.removedecks(topool, impdata.pool || '');
									}
									if (false) {
										user.origName = data.name;
										user.pool = etgutil.mergedecks(user.pool, newpool);
										user.accountbound = etgutil.mergedecks(
											user.accountbound,
											newbound,
										);
										sockEmit(this, 'addpools', {
											c: newpool,
											b: newbound,
											msg: `Imported ${newpool}${newbound}`,
										});
										return db.hset(
											'ImportOriginal',
											data.name,
											JSON.stringify({
												name: user.name,
												bound: newbound,
												pool: newpool,
											}),
										);
									} else {
										sockEmit(this, 'chat', {
											msg: `Feature in development. Would import: ${newpool} ${newbound}`,
											mode: 1,
										});
									}
								})
								.then(() => lock.q.size || importlocks.delete(data.name));
						});
					},
				)
				.on('error', err => {
					console.error(err);
					sockEmit(this, 'chat', { msg: err.message, mode: 1 });
				});
			req.write(reqdata);
			req.end();
		},
		passchange(data, user) {
			user.salt = '';
			if (!data.p) {
				user.auth = '';
				sockEmit(this, 'passchange', { auth: '' });
			} else {
				sutil.initsalt(user);
				crypto.pbkdf2(
					data.p,
					user.salt,
					user.iter,
					64,
					user.algo,
					(err, key) => {
						if (!err) {
							user.auth = key.toString('base64');
							sockEmit(this, 'passchange', { auth: user.auth });
						}
					},
				);
			}
		},
		chat(data) {
			const { to } = data;
			if (to) {
				const sockto = Us.socks.get(to);
				if (sockto && sockto.readyState === 1) {
					sockEmit(sockto, 'chat', {
						msg: data.msg,
						mode: 2,
						u: data.u,
					});
					sockEmit(this, 'chat', {
						msg: data.msg,
						mode: 2,
						u: 'To ' + to,
					});
				} else
					sockEmit(this, 'chat', {
						mode: 1,
						msg: `${to} isn't here right now.\nFailed to deliver: ${data.msg}`,
					});
			} else {
				genericChat(this, data);
			}
		},
		bzcancel(data, user) {
			Bz.load().then(bz => {
				const code = data.c | 0,
					bids = bz[code];
				if (bids) {
					for (let i = bids.length - 1; i >= 0; i--) {
						const bid = bids[i];
						if (bid.u === user.name) {
							const { q, p } = bid;
							if (p > 0) {
								user.gold += p * q;
							} else {
								user.pool = etgutil.addcard(user.pool, code, q);
							}
							bids.splice(i, 1);
						}
					}
					sockEmit(this, 'bzbid', {
						bz,
						g: user.gold,
						pool: user.pool,
					});
					Bz.store();
				}
			});
		},
		bzbid(data, user) {
			data.price |= 0;
			if (!data.price) return;
			Bz.load().then(bz => {
				for (const [code, count] of etgutil.iterraw(data.cards)) {
					const card = Cards.Codes[code];
					if (!card) continue;
					const bc = bz[code] || (bz[code] = []);
					const sellval = userutil.sellValue(card);
					let codeCount = data.price > 0 ? 0 : etgutil.count(user.pool, code);
					if (data.price > 0) {
						if (data.price <= sellval) {
							continue;
						}
					} else {
						if (-data.price <= sellval) {
							if (codeCount >= count) {
								user.gold += sellval * count;
								user.pool = etgutil.addcard(user.pool, code, -count);
							}
							continue;
						}
					}
					for (let i = 0; i < bc.length; i++) {
						const bci = bc[i],
							amt = Math.min(bci.q, count);
						let happened = 0;
						if (data.price > 0) {
							if (bci.p < 0 && -bci.p <= data.price) {
								happened = amt;
							}
						} else {
							if (bci.p > 0 && bci.p <= -data.price) {
								happened = -amt;
							}
						}
						const cost = Math.abs(bci.p) * happened;
						if (
							happened &&
							(data.price > 0 ? user.gold >= cost : codeCount >= happened)
						) {
							user.gold -= cost;
							user.pool = etgutil.addcard(user.pool, code, happened);
							codeCount += happened;
							const SellFunc = seller => {
								const msg = {};
								if (data.price > 0) {
									msg.msg = `${user.name} bought ${amt} of ${
										card.name
									} @ ${-bci.p} from you.`;
									msg.g = cost;
									seller.gold += cost;
								} else {
									msg.msg = `${user.name} sold you ${amt} of ${card.name} @ ${bci.p}`;
									msg.c = etgutil.encodeCount(amt) + code.toString(32);
									seller.pool = etgutil.addcard(seller.pool, code, amt);
								}
								const sellerSock = Us.socks.get(seller.name);
								if (sellerSock) {
									sockEmit(sellerSock, 'bzgive', msg);
								}
							};
							if (bci.u === user.name) {
								SellFunc(user);
							} else {
								Us.load(bci.u)
									.then(SellFunc)
									.catch(() => {});
							}
							if (bci.q > count) {
								bci.q -= count;
								count = 0;
							} else {
								bc.splice(i--, 1);
								if (!bc.length) delete bz[code];
								count -= bci.q;
							}
							if (!count) break;
						}
					}
					if (count > 0) {
						let bidmade = false;
						if (data.price > 0) {
							if (user.gold >= data.price * count) {
								user.gold -= data.price * count;
								bidmade = true;
							}
						} else {
							if (codeCount >= count) {
								user.pool = etgutil.addcard(user.pool, code, -count);
								codeCount -= count;
								bidmade = true;
							}
						}
						if (bidmade) {
							let hadmerge = false;
							for (let i = 0; i < bc.length; i++) {
								const bci = bc[i];
								if (bci.u === user.name && bci.p === data.price) {
									bci.q += count;
									hadmerge = true;
									break;
								}
							}
							if (!hadmerge) {
								bc.push({
									q: count,
									u: user.name,
									p: data.price,
								});
								bc.sort(
									(a, b) =>
										(a.p > 0) - (b.p > 0) || Math.abs(a.p) - Math.abs(b.p),
								);
							}
						}
					}
				}
				sockEmit(this, 'bzbid', {
					bz,
					g: user.gold,
					pool: user.pool,
				});
				Bz.store();
			});
		},
		booster(data, user) {
			const pack = [
				{ amount: 10, cost: 15, rare: [] },
				{ amount: 6, cost: 25, rare: [3] },
				{ amount: 5, cost: 77, rare: [1, 3] },
				{ amount: 9, cost: 100, rare: [4, 7, 8] },
				{ amount: 1, cost: 250, rare: [0, 0, 0, 0] },
			][data.pack];
			if (!pack) return;
			const bumprate = 0.45 / pack.amount;
			const bound = user.freepacks && user.freepacks[data.pack] > 0;
			if (!bound && data.bulk) {
				pack.amount *= data.bulk;
				pack.cost *= data.bulk;
				for (let i = 0; i < pack.rare.length; i++) pack.rare[i] *= data.bulk;
			}
			if (bound || user.gold >= pack.cost) {
				let newCards = '',
					rarity = 1;
				for (let i = 0; i < pack.amount; i++) {
					while (i === pack.rare[rarity - 1]) rarity++;
					let cardcode;
					if (rarity === 5) {
						cardcode =
							etg.NymphList[
								data.element > 0 && data.element < 13
									? data.element
									: RngMock.upto(12) + 1
							];
					} else {
						const notFromElement = Math.random() > 0.5,
							bumprarity = rarity + (Math.random() < bumprate);
						let card = undefined;
						if (data.element < 13)
							card = RngMock.randomcard(
								false,
								x =>
									(x.element === data.element) ^ notFromElement &&
									x.rarity === bumprarity,
							);
						cardcode = (
							card || RngMock.randomcard(false, x => x.rarity === bumprarity)
						).code;
					}
					newCards = etgutil.addcard(newCards, cardcode);
				}
				if (bound) {
					user.freepacks[data.pack]--;
					user.accountbound = etgutil.mergedecks(user.accountbound, newCards);
					if (user.freepacks.every(x => x === 0)) {
						delete user.freepacks;
					}
				} else {
					user.gold -= pack.cost;
					user.pool = etgutil.mergedecks(user.pool, newCards);
				}
				sockEmit(this, 'boostergive', {
					cards: newCards,
					accountbound: bound,
					packtype: data.pack,
				});
			}
		},
		foecancel(data, user, info) {
			if (info.duel) {
				const foesock = Us.socks.get(info.duel);
				if (foesock) {
					const foemeta = sockmeta.get(foesock);
					sockEmit(foesock, 'foeleft', { name: data.u });
					sockEmit(foesock, 'chat', {
						mode: 1,
						msg: `${data.u} has canceled the duel.`,
					});
					if (foemeta.duel === data.u) delete foemeta.duel;
				}
				delete info.duel;
				delete info.spectators;
			}
		},
		matchconfig(data, user, info) {
			const { match } = info;
			if (!match) {
				info.host = user.name;
				info.match = {
					room: new Set([user.name]),
					invites: new Set(),
					config: data.data,
					data: new Map(),
					set: data.set,
				};
				return;
			}
			match.config = data.data;
			match.set = data.set;
			for (const u of match.room) {
				if (u !== user.name) {
					const s = Us.socks.get(u);
					sockEmit(s, 'matchconfig', {
						data: match.config,
						set: match.set,
					});
				}
			}
		},
		matchinvite(data, user, info) {
			let { match } = info;
			const invitedsock = Us.socks.get(data.invite);
			if (invitedsock) {
				if (!match) {
					info.host = user.name;
					info.match = match = {
						room: new Set([user.name]),
						invites: new Set(),
						config: [[{ idx: 1, user: user.name }]],
						data: new Map(),
					};
				}
				match.invites.add(data.invite);
				sockEmit(invitedsock, 'matchinvite', { u: user.name });
			} else {
				sockEmit(this, 'chat', {
					mode: 1,
					msg: `${data.invite} isn't online`,
				});
			}
		},
		matchcancel(data, user, info) {
			const { match } = info;
			if (match) {
				for (const u of match.room) {
					const s = Us.socks.get(u);
					sockEmit(s, 'matchcancel');
				}
				delete info.match;
			}
		},
		matchleave(data, user, info) {
			const { host } = info;
			if (!host) return;
			const hostsock = Us.socks.get(host),
				hostmeta = sockmeta.get(hostsock);
			if (!hostmeta) return;
			const { match } = hostmeta;
			if (!match) return;
			hostmeta.match.room.delete(user.name);
			for (const u of hostmeta.match.room) {
				const s = Us.socks.get(u);
				sockEmit(s, 'foeleft', { name: user.name });
			}
		},
		matchremove(data, user, info) {
			const { match } = info;
			if (match) {
				for (const u of match.room) {
					const s = Us.socks.get(u);
					sockEmit(s, 'foeleft', { name: data.name });
				}
				delete info.match;
			}
		},
		matchjoin(data, user, info) {
			const hostsock = Us.socks.get(data.host),
				hostmeta = sockmeta.get(hostsock);
			if (!hostmeta) {
				sockEmit(this, 'chat', {
					mode: 1,
					msg: `${data.host} isn't online`,
				});
				return;
			}
			const { match } = hostmeta;
			if (!match) {
				sockEmit(this, 'chat', {
					mode: 1,
					msg: `${data.host} isn't hosting`,
				});
				return;
			}
			if (!match.invites.delete(user.name)) {
				sockEmit(this, 'chat', {
					mode: 1,
					msg: `${data.host} hasn't invited you`,
				});
				return;
			}
			info.host = data.host;
			for (const group of match.config) {
				for (const player of group) {
					if (player.user === user.name) {
						player.pending = 1;
					}
				}
			}
			for (const u of match.room) {
				const s = Us.socks.get(u);
				sockEmit(s, 'matchready', { name: user.name, pending: 1 });
			}
			match.room.add(user.name);
			sockEmit(this, 'matchgive', {
				groups: match.config,
				set: match.set,
			});
		},
		matchready(data, user, info) {
			const { host } = info;
			if (!host) {
				sockEmit(this, 'chat', {
					mode: 1,
					msg: "You aren't in a lobby",
				});
				return;
			}
			const hostsock = Us.socks.get(host),
				hostmeta = sockmeta.get(hostsock);
			if (!hostmeta) {
				sockEmit(this, 'chat', {
					mode: 1,
					msg: `${host} isn't online`,
				});
				return;
			}
			const { match } = hostmeta;
			if (!match) {
				sockEmit(this, 'chat', {
					mode: 1,
					msg: `${host} isn't hosting`,
				});
				return;
			}
			hostmeta.match.data.set(user.name, data.data);
			for (const group of hostmeta.match.config) {
				for (const player of group) {
					if (player.user === user.name) {
						delete player.pending;
					}
				}
			}
			for (const u of hostmeta.match.room) {
				const s = Us.socks.get(u);
				sockEmit(s, 'matchready', { name: user.name });
			}
		},
		matchbegin(data, user, info) {
			const hostmeta = info,
				{ match } = hostmeta;
			if (!match) {
				sockEmit(this, 'chat', { mode: 1, msg: "You aren't hosting" });
			}
			const players = [];
			let idx = 1;
			for (const group of match.config) {
				if (!group.length) continue;
				const leader = idx;
				for (const player of group) {
					const pldata = {
						...match.data.get(player.user),
						name: player.user || 'AI',
						user: player.user,
						idx: idx++,
						leader: leader,
					};
					if (player.deck) pldata.deck = player.deck;
					if (player.markpower) pldata.markpower = player.markpower;
					if (player.deckpower) pldata.deckpower = player.deckpower;
					if (player.drawpower) pldata.drawpower = player.drawpower;
					if (!player.user) pldata.ai = 1;
					players.push(pldata);
				}
			}
			const gameData = {
				cardreward: '',
				seed: (Math.random() * MAX_INT) | 0,
				players: RngMock.shuffle(players),
				set: match.set,
			};
			for (const u of match.room) {
				const s = Us.socks.get(u);
				sockEmit(s, 'matchbegin', { data: gameData });
			}
		},
		move(data, user, info) {
			const { host } = info;
			if (!host) {
				const { duel } = info;
				if (duel) {
					const foesock = Us.socks.get(duel);
					sockEmit(foesock, 'move', data);
					return;
				}
				sockEmit(this, { mode: 1, msg: "You aren't in a match" });
			}
			const hostsock = Us.socks.get(host),
				hostmeta = sockmeta.get(hostsock),
				match = hostmeta && hostmeta.match;
			if (!match) {
				sockEmit(this, { mode: 1, msg: `${host} isn't hosting` });
			} else {
				for (const u of match.room) {
					if (u !== user.name) {
						const s = Us.socks.get(u);
						sockEmit(s, 'move', data);
					}
				}
			}
		},
	};
	const sockEvents = {
		login: login(sockEmit),
		async konglogin(data) {
			const key = await db.get('kongapi');
			if (!key) {
				sockEmit(this, 'login', {
					err: 'Global error: no kong api in db',
				});
				return;
			}
			https
				.get(
					`https://api.kongregate.com/api/authenticate.json?user_id=${data.u}&game_auth_token=${data.g}&api_key=${key}`,
					res => {
						const chunks = [];
						res.on('data', chunk => chunks.push(chunk));
						res.on('end', () => {
							const json = sutil.parseJSON(Buffer.concat(chunks).toString());
							if (!json) {
								sockEmit(this, 'login', {
									err: 'Kong returned invalid JSON',
								});
								return;
							}
							if (json.success) {
								const name = 'Kong:' + json.username;
								Us.load(name)
									.then(user => {
										user.auth = data.g;
										sockEvents.login.call(this, {
											u: name,
											a: data.g,
										});
										const req = https
											.request({
												hostname: 'www.kongregate.com',
												path: '/api/submit_statistics.json',
												method: 'POST',
											})
											.on('error', e => console.log(e));
										req.write(
											`user_id=${data.u}\ngame_auth_token=${
												data.g
											}\napi_key=${key}\nWealth=${user.gold +
												userutil.calcWealth(user.pool)}`,
										);
										req.end();
									})
									.catch(() => {
										Us.users.set(name, {
											name,
											gold: 0,
											auth: data.g,
										});
										sockEvents.login.call(this, {
											u: name,
											a: data.g,
										});
									});
							} else {
								sockEmit(this, 'login', {
									err: `${json.error}: ${json.error_description}`,
								});
							}
						});
					},
				)
				.on('error', e => console.log(e));
		},
		async guestchat(data) {
			const isBanned = await db.get('GuestsBanned');
			if (!isBanned) {
				data.guest = true;
				data.u = `Guest_${data.u}`;
				genericChat(this, data);
			}
		},
		roll(data) {
			const A = Math.min(data.A || 1, 99),
				X = data.X || MAX_INT;
			let sum = 0;
			for (let i = 0; i < A; i++) {
				sum += RngMock.upto(X) + 1;
			}
			data.sum = sum;
			broadcast(data);
		},
		async motd(data) {
			const ms = await pg.pool.query(`select id, val from motd order by id`);
			for (const row of ms.rows) {
				sockEmit(this, 'chat', {
					mode: 1,
					msg: `motd ${row.id} ${row.val}`,
				});
			}
		},
		mod: listRoleHandler('Mod'),
		codesmith: listRoleHandler('Codesmith'),
		librarywant(data) {
			return Us.load(data.f)
				.then(user => {
					sockEmit(this, 'librarygive', {
						pool: user.pool,
						bound: user.accountbound,
						gold: user.gold,
						pvpwins: user.pvpwins,
						pvplosses: user.pvplosses,
						aiwins: user.aiwins,
						ailosses: user.ailosses,
					});
				})
				.catch(() => {});
		},
		async arenatop(data) {
			const day = sutil.getDay();
			const obj = await pg.pool.query({
				text: `select u.name, a.code, ($1 - a.day) day, a.won, a.loss, a.score from arena a join users u on u.id = a.user_id where a.arena_id = $2 order by a.score desc limit 20`,
				values: [day, data.lv ? 2 : 1],
			});
			sockEmit(this, 'arenatop', {
				top: obj.rows.map(row => [
					row.name,
					row.score,
					row.won,
					row.loss,
					row.day,
					row.code,
				]),
				lv: data.lv,
			});
		},
		async wealthtop(data) {
			const obj = await pg.pool.query({
				text: `select u.name, u.wealth from users order by wealth desc limit 50`,
			});
			const top = [];
			for (const row of obj.rows) {
				top.push(row.name, row.wealth);
			}
			sockEmit(this, 'wealthtop', { top });
		},
		chatus(data) {
			const thismeta = sockmeta.get(this);
			if (data.hide !== undefined) thismeta.offline = data.hide;
			if (data.want !== undefined) thismeta.wantpvp = data.want;
			if (data.afk !== undefined) thismeta.afk = data.afk;
		},
		who(data) {
			sockEmit(this, 'chat', { mode: 1, msg: activeUsers().join(', ') });
		},
		async bzread(data) {
			const bz = await Bz.load();
			sockEmit(this, 'bzread', { bz });
		},
		challrecv(data) {
			const foesock = Us.socks.get(data.f);
			if (foesock && foesock.readyState === 1) {
				const info = sockmeta.get(foesock),
					foename = data.pvp ? info.duel : info.trade ? info.trade.foe : '';
				sockEmit(foesock, 'chat', {
					mode: 1,
					msg: `You have sent a ${
						data.pvp ? 'PvP' : 'trade'
					} request to ${foename}!`,
				});
			}
		},
		cardchosen(data) {
			const thismeta = sockmeta.get(this);
			if (!thismeta.trade) {
				sockEmit(this, { mode: 1, msg: "You aren't in a trade" });
			}
			const foe = Us.socks.get(thismeta.trade.foe);
			sockEmit(foe, 'cardchosen', data);
		},
	};
	function onSocketClose() {
		const info = sockmeta.get(this);
		if (info) {
			if (info.name) {
				Us.socks.delete(info.name);
			}
			if (info.trade) {
				const foesock = Us.socks.get(info.trade.foe);
				if (foesock && foesock.readyState === 1) {
					const foeinfo = sockmeta.get(foesock);
					if (
						foeinfo &&
						foeinfo.trade &&
						Us.socks.get(foeinfo.trade.foe) === this
					) {
						sockEmit(foesock, 'tradecanceled');
						delete foeinfo.trade;
					}
				}
			}
			if (info.host) {
				const hostinfo = sockmeta.get(info.host);
				if (hostinfo) {
					const { match } = hostinfo,
						{ name } = info;
					if (match && name) {
						match.room.delete(user.name);
						for (const u of match.room) {
							const s = Us.socks.get(u);
							sockEmit(s, 'foeleft', { name: user.name });
						}
					}
				}
			}
			if (info.foe) {
				const foeinfo = sockmeta.get(info.foe);
				if (foeinfo && foeinfo.foe === this) {
					sockEmit(info.foe, 'foeleft', { name: info.name });
					delete foeinfo.foe;
				}
			}
		}
	}
	async function onSocketMessage(rawdata) {
		const data = sutil.parseJSON(rawdata);
		if (!data || typeof data !== 'object' || typeof data.x !== 'string') return;
		console.log(data.u, data.x);
		try {
			let func = userEvents[data.x] || usercmd[data.x];
			if (func) {
				const { u } = data;
				if (typeof u === 'string') {
					const result = await pg.pool.query({
						text: 'select id, auth from user where name = $1',
						values: [u],
					});
					if (result.rows.length) {
						const [row] = result.rows;
						if (data.a === row.auth) {
							const user = await Us.load(u);
							const meta = sockmeta.get(this);
							meta.name = u;
							Us.socks.set(u, this);
							delete data.a;
							const res = await Promise.resolve(
								func.call(this, data, user, meta, row.id),
							);
							if (res && func === usercmd[data.x]) {
								Object.assign(user, res);
							}
						}
					}
				}
			} else if ((func = sockEvents[data.x])) {
				func.call(this, data);
			}
		} catch (err) {
			console.log(err);
		}
	}
	function onSocketConnection(socket) {
		sockmeta.set(socket, {});
		socket.on('close', onSocketClose).on('message', onSocketMessage);
	}
	const app = (config.certs
		? https.createServer(
				{
					key: keypem,
					cert: certpem,
				},
				forkcore,
		  )
		: http.createServer(forkcore)
	)
		.listen(config.listen)
		.on('clientError', () => {});
	const wss = new ws.Server({
		server: app,
		clientTracking: true,
		perMessageDeflate: true,
	})
		.on('error', e => console.log(e))
		.on('connection', onSocketConnection);
	process.once('SIGINT', () => {
		console.log('Shutting down');
		app.close();
		wss.close();
		Us.stop()
			.then(() => Promise.all([db.quit(), pg.pool.end()]))
			.catch(err => console.error(err));
	});
})().catch(e =>
	setImmediate(() => {
		throw e;
	}),
);
