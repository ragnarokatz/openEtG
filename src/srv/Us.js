import db from './db.js';
import pg from './pg.js';

const usergc = new Set();
const userps = new Map();
export const users = new Map();
export const socks = new Map();
export async function storeUsers() {
	const margs = [];
	for (const [u, user] of users) {
		if (user.pool || user.accountbound) {
			margs.push(u, JSON.stringify(user));
		}
	}
	if (margs.length > 0) return db.hmset('Users', margs);
}
const usergcloop = setInterval(() => {
	storeUsers().then(() => {
		// Clear inactive users
		for (const u of users.keys()) {
			if (usergc.delete(u)) {
				users.delete(u);
			} else {
				usergc.add(u);
			}
		}
	});
}, 300000);
export function stop() {
	clearInterval(usergcloop);
	return storeUsers();
}
async function _load(name) {
	const result = await pg.pool.query({
		query: `select ud.data from user_data ud join user u where u.name = $1 and ud.type_id = 1`,
		values: [name],
	});
	userps.delete(name);
	if (result.rows.length) {
		const user = JSON.parse(result.rows[0].data);
		users.set(name, user);
		if (!user.streak) user.streak = [];
		return user;
	} else {
		throw new Error('User not found');
	}
}
export async function load(name) {
	const userck = users.get(name);
	if (userck) {
		usergc.delete(name);
		return userck;
	} else {
		const userpck = userps.get(name);
		if (userpck) return userpck;
		const p = _load(name);
		userps.set(name, p);
		return p;
	}
}
