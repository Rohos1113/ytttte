"""Клиент Bitcart: два запроса, никакой автоматики сверх них.

Шлюз у нас свой (`docs/CRYPTO-TOPUP-BITCART.md` §2), API — обычный REST под
`{base}/api`, авторизация одним заголовком `Authorization: <token>` без
`Bearer`. Задача клиента — довезти запрос и вернуть словарь; что делать с
ответом (какой статус, начислять ли), решает `crypto_payments`, а не он.

**Почему ретраев на создание нет.** `POST /api/invoices` не идемпотентен:
повтор после таймаута заведёт на шлюзе второй счёт на те же деньги, и клиент
получит два адреса. Один раз повторить можно только `GET` — чтение не меняет
ничего, а потерянное уведомление вебхука именно чтением и лечится.

**Почему свой `AsyncClient` на запрос.** Клиент живёт в коротких операциях
(создание счёта, сверка), соединение между ними некому переиспользовать:
держать общий экземпляр значило бы завести глобальное состояние, которое
надо закрывать на остановке. Таймаут задаётся целиком, а не только на
чтение: зависший коннект к чужому инстансу — тоже отказ.

**Секреты.** Токен не попадает ни в исключения, ни в `repr`, ни в текст
ошибки. В сообщении об ошибке — код ответа и первые 200 символов тела: этого
хватает, чтобы понять причину («invalid token», «wallet not found»), и
достаточно мало, чтобы не пересказывать в логах содержимое счёта.
"""

from __future__ import annotations

import httpx

#: Сколько символов тела ответа попадает в текст ошибки.
_ERROR_BODY_CHARS = 200


class BitcartError(Exception):
    """Шлюз недоступен или ответил не тем, чего мы ждём."""


class BitcartClient:
    """Тонкая обёртка над API инвойсов Bitcart."""

    def __init__(self, base_url: str, token: str, timeout: float = 15.0) -> None:
        # Хвостовой слэш снимаем здесь: адрес из настроек часто пишут руками,
        # и `//api/invoices` часть прокси-конфигов встречает 404.
        self._base = (base_url or "").strip().rstrip("/")
        self._token = (token or "").strip()
        self._timeout = float(timeout)

    @property
    def base_url(self) -> str:
        return self._base

    def __repr__(self) -> str:
        # Токен не показываем даже в отладочных дампах объекта.
        return f"BitcartClient(base_url={self._base!r})"

    async def create_invoice(self, payload: dict) -> dict:
        """Создать счёт. Повторов нет намеренно — см. докстроку модуля."""
        return await self._request("POST", "/api/invoices", payload=payload)

    async def get_invoice(self, invoice_id: str) -> dict:
        """Прочитать счёт. Один повтор при транспортной ошибке — здесь безопасно."""
        return await self._request("GET", f"/api/invoices/{invoice_id}", retry_transport=True)

    async def _request(
        self,
        method: str,
        path: str,
        *,
        payload: dict | None = None,
        retry_transport: bool = False,
    ) -> dict:
        if not self._base:
            raise BitcartError("адрес Bitcart не задан")
        headers = {"Authorization": self._token, "Accept": "application/json"}
        response = await self._send(method, f"{self._base}{path}", headers, payload, retry_transport)
        if response.status_code >= 400:
            snippet = " ".join(response.text[:_ERROR_BODY_CHARS].split())
            raise BitcartError(f"Bitcart ответил {response.status_code}: {snippet}")
        try:
            data = response.json()
        except ValueError as exc:
            raise BitcartError("Bitcart вернул не JSON") from exc
        if not isinstance(data, dict):
            raise BitcartError("Bitcart вернул не объект")
        return data

    async def _send(
        self,
        method: str,
        url: str,
        headers: dict[str, str],
        payload: dict | None,
        retry_transport: bool,
    ) -> httpx.Response:
        attempts = 2 if retry_transport else 1
        last: BitcartError | None = None
        for attempt in range(1, attempts + 1):
            try:
                async with httpx.AsyncClient(
                    timeout=httpx.Timeout(self._timeout),
                    follow_redirects=False,
                ) as client:
                    return await client.request(method, url, headers=headers, json=payload)
            except httpx.HTTPError as exc:
                # TransportError — сеть/таймаут; остальные HTTPError (кривой
                # URL, слишком много редиректов) тоже не должны вылетать
                # наружу сырым исключением: роутер ждёт BitcartError.
                # Текст httpx содержит URL, но не заголовки — токена в нём нет.
                last = BitcartError(f"Bitcart недоступен: {type(exc).__name__}")
                if attempt < attempts:
                    continue
        raise last or BitcartError("Bitcart недоступен")
