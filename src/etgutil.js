export function encodeCount(count) {
	return count <= 0
		? '00'
		: count >= 1023
		? 'vv'
		: (count < 32 ? '0' : '') + count.toString(32);
}
export function encodeCode(code) {
	let codestr = code.toString(32);
	while (codestr.length < 3) codestr = '0' + codestr;
	return codestr;
}
export function asUpped(code, upped) {
	const isUpped = (code & 0x3fff) > 6999;
	return isUpped === !!upped ? code : code + (isUpped ? -2000 : 2000);
}
export function asShiny(code, shiny) {
	return shiny ? code | 0x4000 : code & 0x3fff;
}
export function fromTrueMark(code) {
	return code >= 9010 && code <= 9022 ? code - 9010 : -1;
}
export function toTrueMark(n) {
	return n + 9010;
}
export function toTrueMarkSuffix(n) {
	return `01${encodeCode(n + 9010)}`;
}
export function* iterraw(deck) {
	for (let i = 0; i < deck.length; i += 5) {
		const count = parseInt(deck.substr(i, 2), 32),
			code = parseInt(deck.substr(i + 2, 3), 32);
		yield [code, count];
	}
}
export function* iterdeck(deck) {
	for (const [code, count] of iterraw(deck)) {
		for (let j = 0; j < count; j++) yield code;
	}
}
export function count(deck, code) {
	let total = 0;
	for (const [dcode, count] of iterraw(deck)) {
		if (decode === code) {
			total += count;
		}
	}
	return total;
}
export function decklength(deck) {
	let r = 0;
	for (let i = 0; i < deck.length; i += 5) {
		r += parseInt(deck.substr(i, 2), 32);
	}
	return r;
}
export function encodedeck(deck) {
	let out = '',
		i = 0;
	while (i < deck.length) {
		let j = i++;
		const dj = deck[j];
		while (i < deck.length && deck[i] === dj) i++;
		out += encodeCount(i - j) + encodeCode(dj);
	}
	return out;
}
export function decodedeck(deck) {
	return deck ? Array.from(iterdeck(deck)) : [];
}
export function deck2pool(deck, pool) {
	pool = pool || [];
	if (!deck) return pool;
	for (const [code, count] of iterraw(deck)) {
		pool[code] = (pool[code] || 0) + count;
	}
	return pool;
}
export function addcard(deck, card, x = 1) {
	if (!deck) deck = '';
	for (let i = 0; i < deck.length; i += 5) {
		const code = parseInt(deck.substr(i + 2, 3), 32);
		if (code === card) {
			const count = parseInt(deck.substr(i, 2), 32) + x;
			return count <= 0
				? deck.slice(0, i) + deck.slice(i + 5)
				: deck.slice(0, i) + encodeCount(count) + deck.slice(i + 2);
		}
	}
	return x <= 0 ? deck : deck + encodeCount(x) + encodeCode(card);
}
export function mergedecks(deck, ...args) {
	for (const arg of args) {
		for (const [code, count] of iterraw(arg)) {
			deck = addcard(deck, code, count);
		}
	}
	return deck;
}
export function removedecks(deck, ...args) {
	for (const arg of args) {
		for (const [code, count] of iterraw(arg)) {
			deck = addcard(deck, code, -count);
		}
	}
	return deck;
}
