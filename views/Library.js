'use strict';
const Cards = require('../Cards'),
	etgutil = require('../etgutil'),
	userutil = require('../userutil'),
	Components = require('../Components'),
	React = require('react');

module.exports = class Library extends React.Component {
	constructor(props) {
		super(props);
		this.state = {
			code: 0,
			showbound: false,
		};
	}

	render() {
		const cardpool = etgutil.deck2pool(this.props.pool),
			boundpool = etgutil.deck2pool(this.props.bound);
		let progressmax = 0,
			progress = 0,
			shinyprogress = 0;
		Cards.Codes.forEach((card, code) => {
			if (
				!card.upped &&
				!card.shiny &&
				card.type &&
				!card.status.get('token')
			) {
				progressmax += 42;
				let upcode = etgutil.asUpped(code, true);
				progress += Math.min(
					(cardpool[code] || 0) +
						(boundpool[code] || 0) +
						((cardpool[upcode] || 0) + (boundpool[upcode] || 0)) * 6,
					42,
				);
				code = etgutil.asShiny(code, true);
				upcode = etgutil.asUpped(code, true);
				shinyprogress += Math.min(
					(cardpool[code] || 0) +
						(boundpool[code] || 0) +
						((cardpool[upcode] || 0) + (boundpool[upcode] || 0)) * 6,
					42,
				);
			}
		});
		const wealth = this.props.gold + userutil.calcWealth(cardpool);
		return <>
			<span style={{
				position: 'absolute',
				left: '100px',
				top: '16px',
				whiteSpace: 'pre',
			}}>
				Cumulative wealth: {Math.round(wealth)}
				{'\nZE Progress: '}{progress} / {progressmax}
				{'\nSZE Progress: '}{shinyprogress} / {progressmax}
			</span>
			<span style={{
				position: 'absolute',
				left: '333px',
				top: '16px',
				whiteSpace: 'pre',
			}}>
				PvE {this.props.aiwins} - {this.props.ailosses}
				{'\nPvP '}{this.props.pvpwins} - {this.props.pvplosses}
			</span>
			<Components.Card x={734} y={8} code={this.state.code} />
			<input type='button'
				value='Toggle Bound'
				style={{
					position: 'absolute',
					left: '5px',
					top: '554px',
				}}
				onClick={() => {
					this.setState({ showbound: !this.state.showbound });
				}}
			/>
			<Components.ExitBtn x={8} y={8} />
			<Components.CardSelector
				cardpool={this.state.showbound ? boundpool : cardpool}
				filterboth
				onMouseOver={code => {
					code != this.state.code && this.setState({ code: code });
				}}
			/>
		</>;
	}
};
