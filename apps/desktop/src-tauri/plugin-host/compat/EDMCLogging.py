"""
Loggers for plugins.

Each plugin gets a logger under the app's name. Output goes to the host's log
file in the app's data folder, never to the network.
"""

from __future__ import annotations

import logging

from config import appname


def get_main_logger(sublogger_name: str = '') -> logging.Logger:
    return logging.getLogger(appname if not sublogger_name else f'{appname}.{sublogger_name}')


def get_plugin_logger(plugin_name: str, loglevel: int = logging.INFO) -> logging.Logger:
    logger = logging.getLogger(f'{appname}.{plugin_name}')
    logger.setLevel(loglevel)
    return logger


class Logger:
    def __init__(self, logger_name: str, loglevel: int = logging.DEBUG) -> None:
        self.logger = get_main_logger(logger_name)

    def get_logger(self) -> logging.Logger:
        return self.logger


logger = get_main_logger()
