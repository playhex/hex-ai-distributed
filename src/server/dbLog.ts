import mysql from 'mysql2/promise';
import logger from '../shared/logger';

/*
If MYSQL_DATABASE_URI is set, will log position processed by server.
Positions can be retrieved through api.

CREATE TABLE `processed_position` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `type` varchar(16) NOT NULL,
  `position` varchar(255) NOT NULL,
  `createdAt` datetime NOT NULL ON UPDATE CURRENT_TIMESTAMP,
  `ip` varchar(16) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `position` (`position`),
  KEY `createdAt` (`createdAt`),
  KEY `ip` (`ip`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;
 */

const { MYSQL_DATABASE_URI } = process.env;

const anonymizeIp = (ip: string) => {
    if (ip.includes('.')) {
        return ip.split('.').slice(0, 2).join('.');
    }

    return ip.split(':').slice(0, 4).join(':');
};

type GetPositionsParameters = {
    createdAfter?: string;
    createdBefore?: string;
};

export const getPositions = async (parameters: GetPositionsParameters = {}): Promise<{ type: string, position: string, createdAt: Date }[]> => {
    if (!MYSQL_DATABASE_URI) {
        return [];
    }

    let connection: null | mysql.Connection = null;

    try {
        connection = await mysql.createConnection(MYSQL_DATABASE_URI);

        connection.config.namedPlaceholders = true;

        const sql = `
            select type, position, createdAt
            from processed_position
            where createdAt <= :createdBefore
            and createdAt >= :createdAfter
            order by createdAt desc
            limit 500
        `;

        const sqlParameters = {
            createdAfter: parameters.createdAfter ?? new Date('2000-01-01').toISOString(),
            createdBefore: parameters.createdBefore ?? new Date('2100-01-01').toISOString(),
        };


        const [results] = await connection.execute(sql, sqlParameters);

        connection.destroy();

        return results as { type: string, position: string, createdAt: Date }[];
    } catch (e) {
        console.error(e);
        logger.warning('Error while fetching log from db', { e });
        connection && connection.destroy();
        return [];
    }
};

export const logPositionAnalyzed = async (type: 'analyze' | 'move', position: string, ip: string): Promise<void> => {
    if (!MYSQL_DATABASE_URI) {
        return;
    }

    console.log(ip);
    ip = anonymizeIp(ip);

    let connection: null | mysql.Connection = null;

    try {
        connection = await mysql.createConnection(MYSQL_DATABASE_URI);

        const sql = `
            insert into processed_position (type, position, createdAt, ip)
            values (?, ?, ?, ?)
        `;

        await connection.execute(sql, [type, position, new Date(), ip]);

        connection.destroy();
    } catch (e) {
        logger.warning('Error while inserting log into db', { e });
        connection && connection.destroy();
    }
};
