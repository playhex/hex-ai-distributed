export default class Move
{
    constructor(
        public row: number,
        public col: number,
        public specialMove?: 'swap-pieces' | 'pass',
    ) {}

    /**
     * @throws Error if move is not like "f6", or like "swap-pieces" or "pass"
     */
    static fromString(moveString: string): Move
    {
        if ('swap-pieces' === moveString || 'pass' === moveString) {
            return new Move(-1, -1, moveString);
        }

        const match = moveString.match(/^"?([a-z]{1,2})(\d{1,2})"?$/);

        if (null === match) {
            throw new Error(`Invalid move coords: "${moveString}", expected a move like "c2"`);
        }

        const [, letter, number] = match;
        const letterCol = 1 === letter.length
            ? letter.charCodeAt(0) - 97
            : letter.charCodeAt(1) - 97 + 26 * (letter.charCodeAt(0) - 97 + 1)
        ;

        return new Move(
            parseInt(number, 10) - 1, // "1" is 0
            letterCol, // "a" is 0
        );
    }

    static rowToNumber(row: number): string
    {
        return String(row + 1);
    }

    static colToLetter(col: number): string
    {
        /** letter(4) => "e" */
        const letter = (n: number): string => String.fromCharCode(97 + n);

        return col < 26
            ? letter(col)
            : letter(Math.floor(col / 26) - 1) + letter(col % 26)
        ;
    }

    toString(): string
    {
        if (this.specialMove) {
            return this.specialMove;
        }

        return Move.colToLetter(this.col) + Move.rowToNumber(this.row);
    }

    hasSameCoordsAs(move: Move): boolean
    {
        return this.row === move.row && this.col === move.col;
    }

    clone(): Move
    {
        return new Move(this.row, this.col, this.specialMove);
    }

    cloneMirror(): Move
    {
        return new Move(this.col, this.row, this.specialMove);
    }

    static mirror(move: string): string
    {
        return Move.fromString(move).cloneMirror().toString();
    }
}
