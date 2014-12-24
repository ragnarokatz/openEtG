"use strict";
var px = require("./px");
var gfx = require("./gfx");
var sock = require("./sock");
var chat = require("./chat");
var Cards = require("./Cards");
var etgutil = require("./etgutil");
var userutil = require("./userutil");
var startMenu = require("./MainMenu");
module.exports = function() {
	var view = px.mkView();
	var cardminus = {};
	var btrade = px.domButton("Trade", function() {
		if (!cardChosen){
			if (ownDeck.deck.length > 0) {
				sock.emit("cardchosen", {c: etgutil.encodedeck(ownDeck.deck)});
				console.log("Offered", ownDeck.deck);
				cardChosen = true;
				btrade.value = "Confirm";
				btrade.style.top = "60px";
			}
			else chat("You have to choose at least a card!");
		}else{ // confirm
			if (foeDeck.deck.length > 0) {
				console.log("Confirmed", ownDeck.deck, foeDeck.deck);
				sock.userEmit("confirmtrade", { cards: etgutil.encodedeck(ownDeck.deck), oppcards: etgutil.encodedeck(foeDeck.deck) });
				btrade.style.display = "none";
				var confirmed = new PIXI.Text("Confirmed!", { font: "16px Dosis" });
				confirmed.position.set(10, 110);
				view.addChild(confirmed);
			}
			else chat("Wait for your friend to choose!");
		}
	});
	var ownVal = px.domText(""), foeVal = px.domText("");
	var cardChosen = false;
	function setCardArt(code){
		cardArt.setTexture(gfx.getArt(code));
		cardArt.visible = true;
	}
	var ownDeck = new px.DeckDisplay(30, setCardArt,
		function(i) {
			px.adjust(cardminus, ownDeck.deck[i], -1);
			ownDeck.rmCard(i);
			ownVal.setText(userutil.calcWealth(cardminus) + "");
		}
	);
	var foeDeck = new px.DeckDisplay(30, setCardArt);
	foeDeck.position.x = 450;
	view.addChild(ownDeck);
	view.addChild(foeDeck);
	var dom = [[10, 10, ["Cancel", function() {
		sock.userEmit("canceltrade");
		startMenu();
	}]],
		[100, 235, ownVal],
		[350, 235, foeVal],
		[10, 40, btrade]];

	var cardpool = etgutil.deck2pool(sock.user.pool);
	var cardsel = new px.CardSelector(dom, setCardArt,
		function(code){
			var card = Cards.Codes[code];
			if (ownDeck.deck.length < 30 && !card.isFree() && code in cardpool && !(code in cardminus && cardminus[code] >= cardpool[code])) {
				px.adjust(cardminus, code, 1);
				ownDeck.addCard(code);
				ownVal.setText(userutil.calcWealth(cardminus) + "");
			}
		}
	);
	view.addChild(cardsel);
	var cardArt = new PIXI.Sprite(gfx.nopic);
	cardArt.position.set(734, 8);
	view.addChild(cardArt);
	view.cmds = {
		cardchosen: function(data){
			foeDeck.deck = etgutil.decodedeck(data.c);
			foeDeck.renderDeck(0);
			foeVal.setText(userutil.calcWealth(etgutil.deck2pool(data.c)) + "");
		},
		tradedone: function(data) {
			sock.user.pool = etgutil.mergedecks(sock.user.pool, data.newcards);
			sock.user.pool = etgutil.removedecks(sock.user.pool, data.oldcards);
			startMenu();
		},
		tradecanceled: startMenu,
	};
	px.refreshRenderer({view: view, tdom:dom, next:function() {
		var mpos = px.getMousePos();
		cardArt.visible = false;
		cardsel.next(cardpool, cardminus, mpos);
		foeDeck.next(mpos);
		ownDeck.next(mpos);
	}});
}